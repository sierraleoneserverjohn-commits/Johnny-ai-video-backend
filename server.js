const express = require('express');
const cors = require('cors');

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

  // Detect which keys exist on Render
  const activeProviders = [];
  if (process.env.FAL_KEY) activeProviders.push('fal');
  if (process.env.REPLICATE_API_TOKEN) activeProviders.push('replicate');

  let providersToTry = [];
  if (autoFallback) {
    providersToTry = [provider, ...activeProviders.filter(p => p !== provider)];
    providersToTry = [...new Set(providersToTry)].filter(p => activeProviders.includes(p));
  } else {
    providersToTry = [provider];
  }

  if (providersToTry.length === 0) {
    return res.status(400).json({
      success: false,
      error: `No active API keys found on Render for '${provider}'. Check your Render Environment Variables.`
    });
  }

  let lastError = null;

  for (const currentProvider of providersToTry) {
    try {
      console.log(`Executing engine: [${currentProvider.toUpperCase()}]`);
      let videoUrl = null;

      if (currentProvider === 'fal') {
        videoUrl = await generateFal(prompt, imageUrl, aspectRatio);
      } else if (currentProvider === 'replicate') {
        videoUrl = await generateReplicate(prompt, imageUrl);
      }

      if (videoUrl) {
        console.log(`Successfully generated video via [${currentProvider.toUpperCase()}]`);
        return res.json({ success: true, provider: currentProvider, videoUrl });
      }
    } catch (err) {
      console.error(`Failed on [${currentProvider.toUpperCase()}]:`, err.message);
      lastError = `[${currentProvider.toUpperCase()}]: ${err.message}`;
    }
  }

  return res.status(500).json({
    success: false,
    error: `API generation failed. ${lastError || 'Check your API keys and balances.'}`
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

  console.log('[FAL.AI] Submitting request...');
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
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const requestId = data.request_id;
  if (!requestId) throw new Error('FAL did not return a valid request_id.');

  // Poll status
  const statusUrl = `https://queue.fal.run/fal-ai/minimax/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/minimax/requests/${requestId}`;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': `Key ${FAL_KEY}` }
    });
    
    if (!statusRes.ok) continue;
    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      const resVal = await fetch(resultUrl, {
        headers: { 'Authorization': `Key ${FAL_KEY}` }
      });
      const finalData = await resVal.json();
      return finalData.video?.url || finalData.video_url;
    } else if (statusData.status === 'FAILED') {
      throw new Error(`Processing failed: ${statusData.error || 'Unknown error'}`);
    }
  }
  throw new Error('FAL generation timed out.');
}

// 2. REPLICATE Engine
async function generateReplicate(prompt, imageUrl) {
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) throw new Error('REPLICATE_API_TOKEN environment variable missing on Render.');

  console.log('[Replicate] Submitting request...');
  
  const inputPayload = { prompt, prompt_optimizer: true };
  if (imageUrl) inputPayload.first_frame_image = imageUrl;

  const response = await fetch('https://api.replicate.com/v1/models/minimax/video-01/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: inputPayload })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  let prediction = await response.json();

  while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
    await new Promise(r => setTimeout(r, 4000));
    const checkRes = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    if (!checkRes.ok) continue;
    prediction = await checkRes.json();
  }

  if (prediction.status === 'succeeded') {
    return Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  } else {
    throw new Error(`Replicate generation failed: ${prediction.error || 'Unknown error'}`);
  }
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
