const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;

// API Usage Cost Config (Tokens/Credits deducted per video)
const API_COSTS = {
  fal: 10,
  google: 15,
  replicate: 8,
  leonardo: 12,
  kling: 20
};

app.get('/', (req, res) => {
  res.json({ status: "online", message: "Johnny Tec Modular AI Cluster Active" });
});

// ==========================================
// 1. ISOLATED API METRICS ENDPOINT
// ==========================================
app.get('/api/metrics', async (req, res) => {
  const metrics = {
    fal: { status: !!process.env.FAL_KEY, costPerVideo: API_COSTS.fal, liveCredits: null },
    google: { status: !!process.env.GOOGLE_VEO_API_KEY, costPerVideo: API_COSTS.google },
    replicate: { status: !!process.env.REPLICATE_API_TOKEN, costPerVideo: API_COSTS.replicate },
    leonardo: { status: !!process.env.LEONARDO_API_KEY, costPerVideo: API_COSTS.leonardo },
    kling: { status: !!process.env.KLING_API_KEY, costPerVideo: API_COSTS.kling },
    json2video: { status: !!process.env.JSON2VIDEO_API_KEY }
  };

  // Attempt to fetch live credit balance for FAL.ai
  if (process.env.FAL_KEY) {
    try {
      const falRes = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
        headers: { 'Authorization': `Key ${process.env.FAL_KEY}` }
      });
      if (falRes.ok) {
        const falData = await falRes.json();
        metrics.fal.liveCredits = falData.credits?.current_balance || null;
      }
    } catch (e) {
      console.log('FAL live billing lookup skipped.');
    }
  }

  res.json({ success: true, metrics });
});

// ==========================================
// 2. GENERATE RAW AI VIDEO (NO FORCED POST-PROCESSING)
// ==========================================
app.post('/api/generate-raw', async (req, res) => {
  const { prompt, provider = 'fal', imageUrl, aspectRatio = '16:9' } = req.body;

  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required.' });

  try {
    let rawVideoUrl = null;

    if (provider === 'fal') rawVideoUrl = await generateFal(prompt, imageUrl, aspectRatio);
    else if (provider === 'google') rawVideoUrl = await generateGoogle(prompt);
    else if (provider === 'replicate') rawVideoUrl = await generateReplicate(prompt, imageUrl);
    else if (provider === 'leonardo') rawVideoUrl = await generateLeonardo(prompt, imageUrl);
    else if (provider === 'kling') rawVideoUrl = await generateKling(prompt, imageUrl);

    if (rawVideoUrl) {
      return res.json({ success: true, provider, rawVideoUrl });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. STANDALONE JSON2VIDEO EDITOR ROUTE
// ==========================================
app.post('/api/json2video-render', async (req, res) => {
  const { rawVideoUrl, captionText, voiceoverText, logoUrl, musicUrl } = req.body;

  if (!rawVideoUrl) {
    return res.status(400).json({ success: false, error: 'rawVideoUrl is required.' });
  }

  try {
    const finalUrl = await renderWithJSON2Video(rawVideoUrl, {
      captionText, voiceoverText, logoUrl, musicUrl
    });
    return res.json({ success: true, finalVideoUrl: finalUrl });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// RAW VIDEO GENERATOR FUNCTIONS
// ==========================================
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
  throw new Error('FAL request timed out.');
}

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

async function generateReplicate(prompt, imageUrl) {
  const REPLICATE_KEY = process.env.REPLICATE_API_TOKEN;
  const payload = { input: { prompt } };
  if (imageUrl) payload.input.image = imageUrl;

  // Fixed Official Model Route
  const response = await fetch('https://api.replicate.com/v1/models/wan-video/wan-2.1-1.3b/predictions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

  let pred = await response.json();
  while (pred.status !== 'succeeded' && pred.status !== 'failed') {
    await new Promise(r => setTimeout(r, 4000));
    const cRes = await fetch(pred.urls.get, { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
    if (cRes.ok) pred = await cRes.json();
  }
  if (pred.status === 'succeeded') return Array.isArray(pred.output) ? pred.output[0] : pred.output;
  throw new Error(`Replicate failed: ${pred.error}`);
}

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

async function renderWithJSON2Video(rawVideoUrl, options) {
  const J2V_KEY = process.env.JSON2VIDEO_API_KEY;
  if (!J2V_KEY) throw new Error('JSON2VIDEO_API_KEY missing on Render.');

  const elements = [{ type: "video", url: rawVideoUrl, start: 0 }];

  if (options.captionText) {
    elements.push({
      type: "text", text: options.captionText, start: 0.5, duration: 5,
      style: "subtitle", "font-family": "Montserrat", "font-size": 32,
      color: "#00E5FF", y: "80%", x: "center"
    });
  }

  if (options.logoUrl) {
    elements.push({ type: "image", url: options.logoUrl, width: 120, x: "90%", y: "10%", opacity: 0.8 });
  }

  if (options.voiceoverText) {
    elements.push({ type: "voice", text: options.voiceoverText, voice: "en-US-Neural2-F", start: 0 });
  }

  if (options.musicUrl) {
    elements.push({ type: "audio", url: options.musicUrl, volume: 0.3, start: 0 });
  }

  const response = await fetch('https://api.json2video.com/v2/movies', {
    method: 'POST',
    headers: { 'x-api-key': J2V_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution: "hd", quality: "high", scenes: [{ elements }] })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const projectData = await response.json();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const statusRes = await fetch(`https://api.json2video.com/v2/movies?project=${projectData.project}`, {
      headers: { 'x-api-key': J2V_KEY }
    });
    if (!statusRes.ok) continue;
    const statusData = await statusRes.json();
    if (statusData.movie?.url) return statusData.movie.url;
  }
  throw new Error('JSON2Video render timed out.');
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  
