import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as fal from '@fal-ai/client';
import Replicate from 'replicate';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();

// Configure CORS and JSON payload limit for Base64 image transfers
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '25mb' }));

// Initialize SDK Clients
if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN || '' });
const googleAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// -------------------------------------------------------------------
// PROVIDER HANDLERS
// -------------------------------------------------------------------

// 1. FAL.AI (Hunyuan / Minimax)
async function callFal(prompt, imageUrl) {
  const endpoint = imageUrl ? "fal-ai/minimax-video/image-to-video" : "fal-ai/hunyuan-video";
  const input = { prompt };
  if (imageUrl) input.image_url = imageUrl;

  const result = await fal.subscribe(endpoint, { input });
  return result.data?.video?.url;
}

// 2. REPLICATE (Stable Video Diffusion / Hunyuan Open-Source)
async function callReplicate(prompt, imageUrl) {
  if (imageUrl) {
    const output = await replicate.run(
      "stability-ai/stable-video-diffusion:3f0457e4619da25d21e6fb388ca764009c706e9d1502c51d145115d022d05779",
      { input: { input_image: imageUrl } }
    );
    return Array.isArray(output) ? output[0] : output;
  } else {
    const output = await replicate.run(
      "lucataco/hunyuan-video:847231d798d1a129188e99a8421867140e69a038e21976a4a49c63c22b9c2d1b",
      { input: { prompt, num_frames: 129, resolution: "720p" } }
    );
    return Array.isArray(output) ? output[0] : output;
  }
}

// 3. GOOGLE VEO (AI Studio)
async function callGoogleVeo(prompt) {
  const response = await googleAi.models.generateVideo({
    model: 'veo-2.0-generate-001',
    prompt: prompt,
    config: {
      aspectRatio: '16:9',
      numberOfFrames: 120,
    },
  });
  // Returns video blob or URI
  return response.generatedVideos?.[0]?.video?.uri || response.generatedVideos?.[0]?.url;
}

// 4. LEONARDO.AI API
async function callLeonardo(prompt, imageUrl) {
  const response = await fetch('https://cloud.leonardo.ai/api/rest/v1/generations-motion', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LEONARDO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: prompt,
      imageId: imageUrl ? imageUrl : undefined,
      motionStrength: 5
    })
  });
  const data = await response.json();
  return data?.motionResponseBody?.motionUrl || data?.generations_by_pk?.generated_images[0]?.url;
}

// 5. JSON2VIDEO API
async function callJson2Video(prompt) {
  const response = await fetch('https://api.json2video.com/v2/movies', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.JSON2VIDEO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      comment: "Generated Video",
      resolution: "hd",
      elements: [
        {
          type: "text",
          text: prompt,
          duration: 5,
          style: { "font-size": "30px", "color": "#ffffff" }
        }
      ]
    })
  });
  const data = await response.json();
  return data.url;
}

// Map provider keys to their respective functions
const PROVIDER_MAP = {
  fal: callFal,
  replicate: callReplicate,
  google: callGoogleVeo,
  leonardo: callLeonardo,
  json2video: callJson2Video
};

// -------------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ status: 'active', providers: Object.keys(PROVIDER_MAP) }));

/**
 * POST /api/generate-video
 * Body: { prompt: string, provider?: string, imageUrl?: string, autoFallback?: boolean }
 */
app.post('/api/generate-video', async (req, res) => {
  const { prompt, provider = 'fal', imageUrl, autoFallback = true } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required.' });
  }

  // Set execution queue (Requested provider first, followed by remaining fallbacks)
  const providerOrder = autoFallback
    ? [provider, ...Object.keys(PROVIDER_MAP).filter((p) => p !== provider)]
    : [provider];

  let videoUrl = null;
  let successfulProvider = null;
  const errors = [];

  for (const currentProvider of providerOrder) {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Trying Provider: ${currentProvider}`);
      
      const handler = PROVIDER_MAP[currentProvider];
      if (!handler) continue;

      videoUrl = await handler(prompt, imageUrl);

      if (videoUrl) {
        successfulProvider = currentProvider;
        break; // Stop loop as soon as one provider succeeds
      }
    } catch (err) {
      console.warn(`⚠️ ${currentProvider} failed:`, err.message);
      errors.push({ provider: currentProvider, error: err.message });
    }
  }

  if (videoUrl) {
    return res.json({
      success: true,
      provider: successfulProvider,
      videoUrl: videoUrl
    });
  } else {
    return res.status(500).json({
      success: false,
      error: 'All configured AI video providers failed.',
      details: errors
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Multi-API Video Engine active on port ${PORT}`));
  
