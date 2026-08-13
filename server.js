require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { fal } = require('@fal-ai/serverless-client');
const Replicate = require('replicate');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// Safe Configuration Helper
function configureServices() {
  if (process.env.FAL_KEY) {
    try {
      fal.config({ credentials: process.env.FAL_KEY });
    } catch (e) {
      console.warn('FAL setup warning:', e.message);
    }
  }

  let replicateInstance = null;
  if (process.env.REPLICATE_API_TOKEN) {
    try {
      replicateInstance = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    } catch (e) {
      console.warn('Replicate setup warning:', e.message);
    }
  }
  return replicateInstance;
}

const replicate = configureServices();

// ==========================================
// INDIVIDUAL PROVIDER HANDLERS
// ==========================================

// 1. FAL.AI
async function generateFal(prompt, imageUrl, aspectRatio) {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY environment variable missing on Render.');
  console.log('[FAL.AI] Starting generation...');
  
  const endpoint = imageUrl ? 'fal-ai/minimax-video/image-to-video' : 'fal-ai/hunyuan-video';
  const input = imageUrl 
    ? { prompt, image_url: imageUrl }
    : { prompt, aspect_ratio: aspectRatio || '16:9' };

  const result = await fal.subscribe(endpoint, { input, logs: true });

  if (result?.video?.url) return result.video.url;
  if (result?.data?.video?.url) return result.data.video.url;
  throw new Error('FAL.AI did not return a valid video URL.');
}

// 2. REPLICATE
async function generateReplicate(prompt, imageUrl) {
  if (!replicate) throw new Error('REPLICATE_API_TOKEN environment variable missing on Render.');
  console.log('[Replicate] Starting generation...');
  
  const model = imageUrl 
    ? "stability-ai/stable-video-diffusion:3f0457e4619da6173739e26c2793864390fd65155a704b08c1d0ef80c7307205"
    : "lucataco/hunyuan-video:847da544d0b1a03f569f6888c7512214470dcb512e0f49c06179e8c56c24190c";

  const input = imageUrl ? { input_image: imageUrl } : { prompt };
  const output = await replicate.run(model, { input });
  
  if (Array.isArray(output) && output[0]) return output[0];
  if (typeof output === 'string') return output;
  throw new Error('Replicate did not return a valid video output.');
}

// 3. GOOGLE VEO
async function generateGoogleVeo(prompt, imageUrl) {
  console.log('[Google Veo] Starting generation...');
  const apiKey = process.env.GOOGLE_VEO_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_VEO_API_KEY environment variable missing on Render.');

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

// 4. LEONARDO.AI
async function generateLeonardo(prompt, imageUrl) {
  console.log('[Leonardo.ai] Starting generation...');
  const apiKey = process.env.LEONARDO_API_KEY;
  if (!apiKey) throw new Error('LEONARDO_API_KEY environment variable missing on Render.');

  const response = await axios.post(
    'https://cloud.leonardo.ai/api/rest/v1/generations-motion-init',
    { imageId: imageUrl, motionStrength: 5 },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const generationId = response.data?.motionGenerationJob?.generationId;
  if (!generationId) throw new Error('Failed to initiate Leonardo Motion.');

  let videoUrl = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 4000));
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

// 5. JSON2VIDEO
async function generateJson2Video(prompt) {
  console.log('[JSON2Video] Starting render...');
  const apiKey = process.env.JSON2VIDEO_API_KEY;
  if (!apiKey) throw new Error('JSON2VIDEO_API_KEY environment variable missing on Render.');

  const response = await axios.post(
    'https://api.json2video.com/v2/movies',
    {
      comment: 'Johnny Tec AI Auto-Render',
      resolution: 'hd',
      draft: false,
      scenes: [
        {
          elements: [{ type: 'text', text: prompt, style: 'heading', duration: 5 }],
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

// Map Providers
const PROVIDER_MAP = {
  fal: generateFal,
  replicate: generateReplicate,
  google: generateGoogleVeo,
  leonardo: generateLeonardo,
  json2video: generateJson2Video,
};

const FALLBACK_ORDER = ['fal', 'replicate', 'google', 'leonardo', 'json2video'];

// ==========================================
// MAIN API ENDPOINTS
// ==========================================

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'Online', service: 'Johnny Tec AI Video Backend Cluster' });
});

// Generation Route
app.post('/api/generate-video', async (req, res) => {
  const { prompt, provider = 'fal', autoFallback = true, imageUrl, aspectRatio, resolution } = req.body;

  if (!prompt && !imageUrl) {
    return res.status(400).json({ success: false, error: 'Either a prompt or source photo is required.' });
  }

  console.log(`\n--- Incoming Request | Primary Engine: [${provider.toUpperCase()}] ---`);

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

  return res.status(500).json({
    success: false,
    error: 'All configured API providers failed to generate video or lack active API Keys on Render.',
    details: executionLogs,
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Johnny Tec AI Backend listening on port ${PORT}`);
});
                                          

 
  
