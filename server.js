const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.json({ status: "online", message: "Johnny Tec AI Video & Post-Production Cluster Active" });
});

app.post('/api/generate-video', async (req, res) => {
  const {
    prompt,
    provider = 'fal',
    autoFallback = true,
    imageUrl,
    aspectRatio = '16:9',
    // Custom JSON2Video Post-Production Options
    captionText,
    voiceoverText,
    logoUrl,
    musicUrl
  } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required.' });
  }

  // 1. Identify configured video providers
  const activeProviders = [];
  if (process.env.FAL_KEY) activeProviders.push('fal');
  if (process.env.GOOGLE_VEO_API_KEY) activeProviders.push('google');
  if (process.env.REPLICATE_API_TOKEN) activeProviders.push('replicate');
  if (process.env.LEONARDO_API_KEY) activeProviders.push('leonardo');
  if (process.env.KLING_API_KEY) activeProviders.push('kling');

  let providersToTry = autoFallback
    ? [...new Set([provider, ...activeProviders])].filter(p => activeProviders.includes(p))
    : [provider];

  if (providersToTry.length === 0) {
    return res.status(400).json({
      success: false,
      error: `No active API keys found on Render for requested provider '${provider}'.`
    });
  }

  let rawVideoUrl = null;
  let successfulProvider = null;
  let lastError = null;

  // 2. Route request to selected video API with fallback
  for (const currentProvider of providersToTry) {
    try {
      console.log(`Executing raw video generation on: [${currentProvider.toUpperCase()}]`);

      if (currentProvider === 'fal') {
        rawVideoUrl = await generateFal(prompt, imageUrl, aspectRatio);
      } else if (currentProvider === 'google') {
        rawVideoUrl = await generateGoogle(prompt);
      } else if (currentProvider === 'replicate') {
        rawVideoUrl = await generateReplicate(prompt, imageUrl);
      } else if (currentProvider === 'leonardo') {
        rawVideoUrl = await generateLeonardo(prompt, imageUrl);
      } else if (currentProvider === 'kling') {
        rawVideoUrl = await generateKling(prompt, imageUrl);
      }

      if (rawVideoUrl) {
        successfulProvider = currentProvider;
        console.log(`Raw video ready from [${currentProvider.toUpperCase()}]: ${rawVideoUrl}`);
        break;
      }
    } catch (err) {
      console.error(`Failed on [${currentProvider.toUpperCase()}]:`, err.message);
      lastError = `[${currentProvider.toUpperCase()}]: ${err.message}`;
    }
  }

  if (!rawVideoUrl) {
    return res.status(500).json({
      success: false,
      error: `All raw video API engines failed. ${lastError}`
    });
  }

  // 3. Send raw video to JSON2Video for post-production
  try {
    console.log('Transmitting raw video to JSON2Video engine...');
    const finalRenderedUrl = await renderWithJSON2Video(rawVideoUrl, {
      captionText: captionText || prompt,
      voiceoverText,
      logoUrl,
      musicUrl
    });

    return res.json({
      success: true,
      provider: successfulProvider,
      rawVideoUrl: rawVideoUrl,
      finalVideoUrl: finalRenderedUrl
    });
  } catch (j2vErr) {
    console.error('JSON2Video Post-Production Error:', j2vErr.message);
    // Fallback: Return raw video if JSON2Video is unconfigured or fails
    return res.json({
      success: true,
      provider: successfulProvider,
      warning: `JSON2Video post-processing skipped: ${j2vErr.message}`,
      finalVideoUrl: rawVideoUrl
    });
  }
});

// =========================================================================
// RAW VIDEO PROVIDERS
// =========================================================================

// 1. FAL.AI Engine
async function generateFal(prompt, imageUrl, aspectRatio) {
  const FAL_KEY = process.env.FAL_KEY;
  const endpoint = imageUrl 
    ? 'https://queue.fal.run/fal-ai/minimax/video-01/image-to-video'
    : 'https://queue.fal.run/fal-ai/minimax/video-01';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(imageUrl ? { prompt, image_url: imageUrl } : { prompt, aspect_ratio: aspectRatio })
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();

  // Poll request
  const statusUrl = `https://queue.fal.run/fal-ai/minimax/requests/${data.request_id}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/minimax/requests/${data.request_id}`;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const sRes = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    if (!sRes.ok) continue;
    const sData = await sRes.json();
    if (sData.status === 'COMPLETED') {
      const rRes = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      const rData = await rRes.json();
      return rData.video?.url || rData.video_url;
    }
  }
  throw new Error('FAL timed out.');
}

// 2. GOOGLE VEO Engine
async function generateGoogle(prompt) {
  const GOOGLE_KEY = process.env.GOOGLE_VEO_API_KEY;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predict?key=${GOOGLE_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: { text: prompt } })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.generatedVideos?.[0]?.videoUri;
}

// 3. REPLICATE Engine
async function generateReplicate(prompt, imageUrl) {
  const REPLICATE_KEY = process.env.REPLICATE_API_TOKEN;
  const payload = { input: { prompt } };
  if (imageUrl) payload.input.image = imageUrl;

  const res = await fetch('https://api.replicate.com/v1/models/lucataco/wan-2.1-1.3b/predictions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let pred = await res.json();
  while (pred.status !== 'succeeded' && pred.status !== 'failed') {
    await new Promise(r => setTimeout(r, 4000));
    const cRes = await fetch(pred.urls.get, { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
    if (cRes.ok) pred = await cRes.json();
  }
  if (pred.status === 'succeeded') return Array.isArray(pred.output) ? pred.output[0] : pred.output;
  throw new Error(`Replicate error: ${pred.error}`);
}

// 4. LEONARDO AI Engine
async function generateLeonardo(prompt, imageUrl) {
  const LEONARDO_KEY = process.env.LEONARDO_API_KEY;
  const res = await fetch('https://cloud.leonardo.ai/api/rest/v1/generations-motion', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LEONARDO_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, motionStrength: 5 })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const generationId = data.motionGenerationJob?.generationId;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const cRes = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${LEONARDO_KEY}` }
    });
    if (!cRes.ok) continue;
    const cData = await cRes.json();
    const videoUrl = cData.generations_by_pk?.generated_images?.[0]?.motionMP4URL;
    if (videoUrl) return videoUrl;
  }
  throw new Error('Leonardo timed out.');
}

// 5. KLING / LUMA Engine
async function generateKling(prompt, imageUrl) {
  const KLING_KEY = process.env.KLING_API_KEY;
  const res = await fetch('https://api.klingai.com/v1/videos/text2video', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KLING_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration: "5" })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const taskId = data.data?.task_id;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const cRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
      headers: { 'Authorization': `Bearer ${KLING_KEY}` }
    });
    if (!cRes.ok) continue;
    const cData = await cRes.json();
    if (cData.data?.task_status === 'succeed') {
      return cData.data?.task_result?.videos?.[0]?.url;
    }
  }
  throw new Error('Kling timed out.');
}

// =========================================================================
// POST-PRODUCTION ENGINE (JSON2Video)
// =========================================================================
async function renderWithJSON2Video(rawVideoUrl, options) {
  const J2V_KEY = process.env.JSON2VIDEO_API_KEY;
  if (!J2V_KEY) throw new Error('JSON2VIDEO_API_KEY missing on Render.');

  const elements = [
    // 1. Base Raw AI Video Element
    {
      type: "video",
      url: rawVideoUrl,
      start: 0
    }
  ];

  // 2. Animated Captions / Overlay Text
  if (options.captionText) {
    elements.push({
      type: "text",
      text: options.captionText,
      start: 0.5,
      duration: 5,
      style: "subtitle",
      "font-family": "Montserrat",
      "font-size": 32,
      color: "#00E5FF",
      y: "80%",
      x: "center"
    });
  }

  // 3. Logo Watermark Overlay
  if (options.logoUrl) {
    elements.push({
      type: "image",
      url: options.logoUrl,
      width: 120,
      x: "90%",
      y: "10%",
      opacity: 0.8
    });
  }

  // 4. Voiceover / Text-To-Speech
  if (options.voiceoverText) {
    elements.push({
      type: "voice",
      text: options.voiceoverText,
      voice: "en-US-Neural2-F",
      start: 0
    });
  }

  // 5. Background Music
  if (options.musicUrl) {
    elements.push({
      type: "audio",
      url: options.musicUrl,
      volume: 0.3,
      start: 0
    });
  }

  const payload = {
    resolution: "hd",
    quality: "high",
    scenes: [
      {
        transition: { name: "fade", duration: 0.5 },
        elements: elements
      }
    ]
  };

  const response = await fetch('https://api.json2video.com/v2/movies', {
    method: 'POST',
    headers: {
      'x-api-key': J2V_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`JSON2Video API HTTP ${response.status}: ${errText}`);
  }

  const projectData = await response.json();
  const projectId = projectData.project;

  // Poll project completion
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const statusRes = await fetch(`https://api.json2video.com/v2/movies?project=${projectId}`, {
      headers: { 'x-api-key': J2V_KEY }
    });

    if (!statusRes.ok) continue;
    const statusData = await statusRes.json();

    if (statusData.movie?.url) {
      return statusData.movie.url;
    } else if (statusData.movie?.status === 'error') {
      throw new Error('JSON2Video rendering failed.');
    }
  }

  throw new Error('JSON2Video render timed out.');
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
      
