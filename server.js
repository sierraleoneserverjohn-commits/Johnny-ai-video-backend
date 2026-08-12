require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { fal } = require('@fal-ai/serverless-client');
const Replicate = require('replicate');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS so your GitHub Pages frontend can talk to this server
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// Configure FAL.AI
fal.config({
  credentials: process.env.FAL_KEY,
});

// Configure Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// ==========================================
// INDIVIDUAL PROVIDER HANDLERS
// ==========================================

// 1. FAL.AI (Hunyuan Video / Minimax)
async function generateFal(prompt, imageUrl, aspectRatio) {
  console.log('[FAL.AI] Starting generation...');
  
  // Use image-to-video if photo provided, otherwise text-to-video
  const endpoint = imageUrl ? 'fal-ai/minimax-video/image-to-video' : 'fal-ai/hunyuan-video';
  const input = imageUrl 
    ? { prompt, image_url: imageUrl }
    : { prompt, aspect_ratio: aspectRatio || '16:9' };

  const result = await fal.subscribe(endpoint, {
    input,
    logs: true,
  });

  if (result?.video?.url) return result.video.url;
  if (result?.data?.video?.url) return result.data.video.url;
  throw new Error('FAL.AI did not return a valid video URL.');
}

// 2. REPLICATE (Stable Video Diffusion / Luma Ray)
async function generateReplicate(prompt, imageUrl) {
  console.log('[Replicate] Starting generation...');
  
  // Default to Stable Video Diffusion for Image-to-Video, or Luma Dream Machine
  const model = imageUrl 
    ? "stability-ai/stable-video-diffusion:3f0457e4619da6173739e26c2793864390fd65155a704b08c1d0ef80c7307205"
    : "lucataco/hunyuan-video:847da544d0b1a03f569f6888c7512214470dcb512e0f49c06179e8c56c24190c";

  const input = imageUrl ? { input_image: imageUrl } : { prompt };

  const output = await replicate.run(model, { input });
  
  if (Array.isArray(output) && output[0]) return output[0];
  if (typeof output === 'string') return output;
  throw new Error('Replicate did not return a valid video output.');
}

// 3. GOOGLE VEO (Via Google Vertex AI API)
async function generateGoogleVeo(prompt, imageUrl) {
  console.log('[Google Veo] Starting generation...');
  const apiKey = process.env.GOOGLE_VEO_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_VEO_API_KEY is not configured in environment variables.');

  // Direct REST Call to Google Vertex / Veo endpoint
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/veo-001:generateVideo?key=${apiKey}`,
    {
      prompt: { text: prompt },
      image: imageUrl ? { gcsUri: imageUrl } : undefined,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const videoUri = response.data?.generatedVideos?.[0]?.video?.uri || response.data?.videoUrl;
  if (videoUri) return videoUri;
  throw new Error('Google Veo generation failed or returned empty payload.');
}

// 4. LEONARDO.AI (Motion API)
async function generateLeonardo(prompt, imageUrl) {
  console.log('[Leonardo.ai] Starting generation...');
  const apiKey = process.env.LEONARDO_API_KEY;
  if (!apiKey) throw new Error('LEONARDO_API_KEY is not configured.');

  // First step: Generate image or initiate Motion endpoint
  const response = await axios.post(
    'https://cloud.leonardo.ai/api/rest/v1/generations-motion-init',
    {
      imageId: imageUrl, // Expects Leonardo Image ID or uploaded asset ID
      motionStrength: 5,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const generationId = response.data?.motionGenerationJob?.generationId;
  if (!generationId) throw new Error('Failed to initiate Leonardo Motion.');

  // Poll for result
  let videoUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await axios.get(
      `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const job = statusRes.data?.generations_by_pk;
    if (job?.generated_images?.[0]?.motionMP4URL) {
      videoUrl = job.generated_images[0].motionMP4URL;
      break;
    }
  }

  if (videoUrl) return videoUrl;
  throw new Error('Leonardo.ai motion generation timed out.');
}

// 5. JSON2VIDEO (Template & Caption Engine)
async function generateJson2Video(prompt) {
  console.log('[JSON2Video] Starting render...');
  const apiKey = process.env.JSON2VIDEO_API_KEY;
  if (!apiKey) throw new Error('JSON2VIDEO_API_KEY is not configured.');

  const response = await axios.post(
    'https://api.json2video.com/v2/movies',
    {
      comment: 'Johnny Tec AI Auto-Render',
      resolution: 'hd',
      draft: false,
      scenes: [
        {
          comment: 'Scene 1',
          elements: [
            {
              type: 'text',
              text: prompt,
              style: 'heading',
              duration: 5,
            },
          ],
        },
      ],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    }
  );

  const projectUrl = response.data?.movie?.url;
  if (projectUrl) return projectUrl;
  throw new Error('JSON2Video template creation failed.');
}

// Map provider keys to their handler functions
const PROVIDER_MAP = {
  fal: generateFal,
  replicate: generateReplicate,
  google: generateGoogleVeo,
  leonardo: generateLeonardo,
  json2video: generateJson2Video,
};

// Fallback execution sequence
const FALLBACK_ORDER = ['fal', 'replicate', 'google', 'leonardo', 'json2video'];

// ==========================================
// MAIN API ENDPOINT
// ==========================================
app.post('/api/generate-video', async (req, res) => {
  const { prompt, provider = 'fal', autoFallback = true, imageUrl, aspectRatio, resolution } = req.body;

  if (!prompt && !imageUrl) {
    return res.status(400).json({ success: false, error: 'Either a prompt or source photo is required.' });
  }

  console.log(`\n--- Incoming Request | Primary Engine: [${provider.toUpperCase()}] ---`);

  // Build execution chain: Selected provider first, followed by others if autoFallback is enabled
  const queue = autoFallback
    ? [provider, ...FALLBACK_ORDER.filter((p) => p !== provider)]
    : [provider];

  const executionLogs = [];

  for (const currentProvider of queue) {
    try {
      console.log(`Executing engine: [${currentProvider.toUpperCase()}]`);
      const handler = PROVIDER_MAP[currentProvider];

      if (!handler) {
        throw new Error(`Engine ${currentProvider} is not implemented.`);
      }

      const videoUrl = await handler(prompt, imageUrl, aspectRatio, resolution);

      console.log(`✅ Success via [${currentProvider.toUpperCase()}]: ${videoUrl}`);
      return res.json({
        success: true,
        provider: currentProvider,
        videoUrl: videoUrl,
        logs: executionLogs,
      });
    } catch (err) {
      console.error(`❌ Failed on [${currentProvider.toUpperCase()}]: ${err.message}`);
      executionLogs.push({ provider: currentProvider, error: err.message });
    }
  }

  // If all attempts failed
  return res.status(500).json({
    success: false,
    error: 'All configured API providers failed to generate the video.',
    details: executionLogs,
  });
});

// Health Check Endpoint
app.get('/', (req, res) => {
  res.send({ status: 'Online', service: 'Johnny Tec AI Video Backend Cluster' });
});

app.listen(PORT, () => {
  console.log(`🚀 Johnny Tec AI Backend running on port ${PORT}`);
});
      
