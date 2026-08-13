const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;

// Root Endpoint Health Check
app.get('/', (req, res) => {
  res.json({ status: "online", message: "Johnny Tec AI Video Cluster Active" });
});

// Primary Video Generation Route
app.post('/api/generate-video', async (req, res) => {
  const { prompt, provider = 'fal', autoFallback = true, imageUrl, aspectRatio = '16:9' } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required.' });
  }

  // Provider chain priority order
  const providersToTry = autoFallback
    ? [provider, ...['fal', 'replicate', 'google'].filter(p => p !== provider)]
    : [provider];

  let lastError = null;

  for (const currentProvider of providersToTry) {
    try {
      console.log(`Executing engine: [${currentProvider.toUpperCase()}]`);
      let videoUrl = null;

      if (currentProvider === 'fal') {
        videoUrl = await generateFal(prompt, imageUrl, aspectRatio);
      } else if (currentProvider === 'replicate') {
        videoUrl = await generateReplicate(prompt, imageUrl, aspectRatio);
      } else if (currentProvider === 'google') {
        videoUrl = await generateGoogle(prompt);
      }

      if (videoUrl) {
        console.log(`Successfully generated video via [${currentProvider.toUpperCase()}]`);
        return res.json({ success: true, provider: currentProvider, videoUrl });
      }
    } catch (err) {
      console.error(`Failed on [${currentProvider.toUpperCase()}]:`, err.message);
      lastError = err.message;
    }
  }

  return res.status(500).json({
    success: false,
    error: `All configured API providers failed to generate video or lack active API Keys on Render. Last error: ${lastError}`
  });
});

// --- PROVIDER IMPLEMENTATIONS ---

// 1. FAL.AI Engine
async function generateFal(prompt, imageUrl, aspectRatio) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('FAL_KEY environment variable missing on Render.');

  const endpoint = imageUrl 
    ? 'https://queue.fal.run/fal-ai/minimax/video-01/image-to-video'
    : 'https://queue.fal.run/fal-ai/minimax/video-01';

  const payload = imageUrl ? { prompt, image_url: imageUrl } : { prompt, aspect_ratio: aspectRatio };

  console.log('[FAL.AI] Submitting job...');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`FAL API HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const requestId = data.request_id;
  if (!requestId) throw new Error('FAL did not return a request_id.');

  // Poll for completion
  const statusUrl = `https://queue.fal.run/fal-ai/minimax/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/minimax/requests/${requestId}`;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': `Key ${FAL_KEY}` }
    });
    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      const resVal = await fetch(resultUrl, {
        headers: { 'Authorization': `Key ${FAL_KEY}` }
      });
      const finalData = await resVal.json();
      return finalData.video?.url || finalData.video_url;
    } else if (statusData.status === 'FAILED') {
      throw new Error(`FAL processing failed: ${statusData.error}`);
    }
  }
  throw new Error('FAL request timed out.');
}

// 2. REPLICATE Engine (Updated to active minimax model)
async function generateReplicate(prompt, imageUrl, aspectRatio) {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) throw new Error('REPLICATE_API_TOKEN environment variable missing on Render.');

  console.log('[Replicate] Starting generation...');
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      // Active working model on Replicate
      version: "minimax/video-01",
      input: {
        prompt: prompt,
        prompt_optimizer: true
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Replicate API HTTP ${response.status}: ${errText}`);
  }

  let prediction = await response.json();

  // Poll prediction status
  while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
    await new Promise(r => setTimeout(r, 3000));
    const checkRes = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    prediction = await checkRes.json();
  }

  if (prediction.status === 'succeeded') {
    return Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  } else {
    throw new Error(`Replicate generation failed: ${prediction.error}`);
  }
}

// 3. GOOGLE Engine Placeholder
async function generateGoogle(prompt) {
  const GOOGLE_KEY = process.env.GOOGLE_VEO_API_KEY;
  if (!GOOGLE_KEY) throw new Error('GOOGLE_VEO_API_KEY environment variable missing on Render.');

  throw new Error('Google Veo API endpoint path requires Google Vertex AI project configuration.');
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
