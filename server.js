const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;
const VERSION = "2.0.0";

const API_COSTS = {
  fal: Number(process.env.FAL_COST_PER_VIDEO || 10),
  google: Number(process.env.GOOGLE_COST_PER_VIDEO || 15),
  replicate: Number(process.env.REPLICATE_COST_PER_VIDEO || 8),
  leonardo: Number(process.env.LEONARDO_COST_PER_VIDEO || 12),
  kling: Number(process.env.KLING_COST_PER_VIDEO || 20)
};

const PROVIDER_NAMES = {
  fal: "FAL.AI",
  google: "Google Veo",
  replicate: "Replicate",
  leonardo: "Leonardo AI",
  kling: "Kling",
  json2video: "JSON2Video"
};

const usage = Object.fromEntries(
  Object.keys(PROVIDER_NAMES).map(k => [k, {
    videos: 0, unitsUsed: 0, renders: 0, creditsUsed: 0,
    lastCost: null, lastCredits: null, lastAt: null
  }])
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

function configured(provider) {
  const keys = {
    fal: "FAL_KEY", google: "GOOGLE_VEO_API_KEY",
    replicate: "REPLICATE_API_TOKEN", leonardo: "LEONARDO_API_KEY",
    kling: "KLING_API_KEY", json2video: "JSON2VIDEO_API_KEY"
  };
  return !!process.env[keys[provider]];
}

function recordGeneration(provider, cost) {
  usage[provider].videos++;
  usage[provider].unitsUsed += Number(cost || 0);
  usage[provider].lastCost = cost;
  usage[provider].lastAt = now();
}

function recordJSON2Video(credits) {
  usage.json2video.renders++;
  if (credits != null) usage.json2video.creditsUsed += Number(credits || 0);
  usage.json2video.lastCredits = credits;
  usage.json2video.lastAt = now();
}

async function providerCheck(id) {
  if (!configured(id)) return { status: "offline", reason: `${id} API key missing` };

  const keyMap = {
    fal: ["https://api.fal.ai/v1/account/billing?expand=credits", "Key", "fal"],
    replicate: ["https://api.replicate.com/v1/models?limit=1", "Bearer", "replicate"],
    google: [null, null, "google"]
  };

  try {
    if (id === "google") {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(process.env.GOOGLE_VEO_API_KEY)}`
      );
      if (!r.ok) return { status: "offline", reason: `HTTP ${r.status}` };
      return { status: "active", balance: process.env.GOOGLE_REMAINING_CREDITS || null };
    }

    if (id === "fal") {
      const r = await fetch(keyMap.fal[0], {
        headers: { Authorization: `Key ${process.env.FAL_KEY}` }
      });
      if (!r.ok) return { status: "offline", reason: `HTTP ${r.status}` };
      const d = await r.json();
      return {
        status: "active",
        balance: d?.credits?.current_balance ?? d?.current_balance ?? d?.balance ?? null
      };
    }

    if (id === "replicate") {
      const r = await fetch(keyMap.replicate[0], {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` }
      });
      if (!r.ok) return { status: "offline", reason: `HTTP ${r.status}` };
      return { status: "active", balance: process.env.REPLICATE_REMAINING_CREDITS || null };
    }

    return {
      status: "active",
      balance: process.env[`${id.toUpperCase()}_REMAINING_CREDITS`] || null,
      balanceSource: "provider balance may not be exposed by API"
    };
  } catch (e) {
    return { status: "offline", reason: e.message };
  }
}

async function getProviderStatus() {
  const ids = ["fal", "google", "replicate", "leonardo", "kling", "json2video"];
  const results = {};
  for (const id of ids) {
    results[id] = id === "json2video"
      ? (configured(id) ? { status: "active" } : { status: "offline", reason: "JSON2VIDEO_API_KEY missing" })
      : await providerCheck(id);
  }

  return ids.map(id => ({
    id,
    name: PROVIDER_NAMES[id],
    status: results[id].status,
    balance: results[id].balance ?? null,
    reason: results[id].reason ?? null,
    costPerVideo: API_COSTS[id] ?? null,
    videos: usage[id].videos,
    renders: usage[id].renders,
    used: usage[id].unitsUsed,
    creditsUsed: usage[id].creditsUsed,
    lastCost: usage[id].lastCost,
    lastCredits: usage[id].lastCredits,
    lastAt: usage[id].lastAt,
    checkedAt: now()
  }));
}

app.get("/", (req, res) => res.json({
  status: "online",
  message: "Johnny Tec Modular AI Cluster Active",
  version: VERSION,
  time: now()
}));

app.get("/health", (req, res) => res.json({ status: "ok", version: VERSION, time: now() }));

app.get("/api/providers/status", async (req, res) => {
  try {
    res.json({ success: true, providers: await getProviderStatus(), checkedAt: now() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/metrics", async (req, res) => {
  try {
    const providers = await getProviderStatus();
    const metrics = {};
    for (const p of providers) {
      metrics[p.id] = {
        status: p.status === "active",
        providerStatus: p.status,
        costPerVideo: p.costPerVideo,
        remaining: p.balance,
        used: p.used,
        creditsUsed: p.creditsUsed,
        videos: p.videos,
        renders: p.renders,
        lastCost: p.lastCost,
        lastCredits: p.lastCredits
      };
    }
    res.json({ success: true, metrics, checkedAt: now() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/video/generate", async (req, res) => {
  const {
    prompt, provider = "fal", imageUrl = null,
    aspect_ratio = "16:9", duration = 8,
    json2video = {}
  } = req.body;

  if (!prompt) return res.status(400).json({ success: false, error: "Prompt is required." });

  const allowed = ["fal", "google", "replicate", "leonardo", "kling"];
  if (!allowed.includes(provider))
    return res.status(400).json({ success: false, error: `Unsupported provider: ${provider}` });

  if (!configured(provider))
    return res.status(503).json({ success: false, error: `${PROVIDER_NAMES[provider]} API key is missing.` });

  try {
    const rawVideoUrl = await generateRawVideo({
      provider, prompt, imageUrl, aspectRatio: aspect_ratio, duration
    });

    recordGeneration(provider, API_COSTS[provider]);

    if (json2video.autoRender === false || !configured("json2video")) {
      return res.json({
        success: true, provider, rawVideoUrl,
        finalVideoUrl: null,
        rendered: false,
        json2videoAvailable: configured("json2video"),
        usage: { providerCost: API_COSTS[provider] }
      });
    }

    const finalVideoUrl = await renderWithJSON2Video(rawVideoUrl, {
      captionText: json2video.captionText || "",
      voiceoverText: json2video.voiceoverText || "",
      logoUrl: json2video.logoUrl || "",
      musicUrl: json2video.musicUrl || "",
      duration
    });

    res.json({
      success: true, provider, rawVideoUrl, finalVideoUrl, rendered: true,
      usage: {
        providerCost: API_COSTS[provider],
        json2videoCredits: usage.json2video.lastCredits
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, provider, error: e.message });
  }
});

app.post("/api/generate-raw", async (req, res) => {
  const { prompt, provider = "fal", imageUrl = null, aspectRatio = "16:9", duration = 8 } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: "Prompt is required." });
  try {
    const rawVideoUrl = await generateRawVideo({ provider, prompt, imageUrl, aspectRatio, duration });
    recordGeneration(provider, API_COSTS[provider]);
    res.json({ success: true, provider, rawVideoUrl, costPerVideo: API_COSTS[provider] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/video/render", async (req, res) => {
  const {
    rawVideoUrl, captionText = "", voiceoverText = "",
    logoUrl = "", musicUrl = "", duration = 8
  } = req.body;

  if (!rawVideoUrl) return res.status(400).json({ success: false, error: "rawVideoUrl is required." });

  try {
    const finalVideoUrl = await renderWithJSON2Video(rawVideoUrl, {
      captionText, voiceoverText, logoUrl, musicUrl, duration
    });
    res.json({
      success: true,
      finalVideoUrl,
      creditsUsed: usage.json2video.lastCredits
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/json2video-render", async (req, res) => {
  const { rawVideoUrl, captionText, voiceoverText, logoUrl, musicUrl } = req.body;
  if (!rawVideoUrl) return res.status(400).json({ success: false, error: "rawVideoUrl is required." });
  try {
    const finalVideoUrl = await renderWithJSON2Video(rawVideoUrl, {
      captionText, voiceoverText, logoUrl, musicUrl
    });
    res.json({ success: true, finalVideoUrl, creditsUsed: usage.json2video.lastCredits });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

async function generateRawVideo({ provider, prompt, imageUrl, aspectRatio, duration }) {
  if (provider === "fal") return generateFal(prompt, imageUrl, aspectRatio);
  if (provider === "google") return generateGoogle(prompt, aspectRatio, duration);
  if (provider === "replicate") return generateReplicate(prompt, imageUrl);
  if (provider === "leonardo") return generateLeonardo(prompt, imageUrl);
  if (provider === "kling") return generateKling(prompt, imageUrl, duration);
  throw new Error(`Provider ${provider} is not supported.`);
}

async function generateFal(prompt, imageUrl, aspectRatio) {
  const key = process.env.FAL_KEY;
  const endpoint = imageUrl
    ? "https://queue.fal.run/fal-ai/minimax/video-01/image-to-video"
    : "https://queue.fal.run/fal-ai/minimax/video-01";

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(imageUrl ? { prompt, image_url: imageUrl } : { prompt, aspect_ratio: aspectRatio })
  });

  if (!r.ok) throw new Error(`FAL HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (!d.request_id) throw new Error("FAL did not return request_id.");

  const statusUrl = `https://queue.fal.run/fal-ai/minimax/requests/${d.request_id}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/minimax/requests/${d.request_id}`;

  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    const s = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
    if (!s.ok) continue;
    const sd = await s.json();

    if (sd.status === "COMPLETED") {
      const rr = await fetch(resultUrl, { headers: { Authorization: `Key ${key}` } });
      const rd = await rr.json();
      return rd?.video?.url || rd?.video_url || rd?.output?.video?.url;
    }
    if (sd.status === "FAILED") throw new Error("FAL generation failed.");
  }
  throw new Error("FAL request timed out.");
}

async function generateGoogle(prompt, aspectRatio, duration) {
  const key = process.env.GOOGLE_VEO_API_KEY;
  const model = process.env.GOOGLE_VEO_MODEL || "veo-2.0-generate-001";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(key)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio, durationSeconds: Number(duration) || 8 }
    })
  });

  if (!r.ok) throw new Error(`Google Veo HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();

  if (d?.generatedVideos?.[0]?.videoUri) return d.generatedVideos[0].videoUri;
  if (d?.name) return pollGoogleOperation(d.name, key);
  throw new Error("Google returned no video URL. Check your Veo configuration.");
}

async function pollGoogleOperation(name, key) {
  const base = process.env.GOOGLE_VEO_OPERATION_BASE || "https://generativelanguage.googleapis.com/v1beta";
  for (let i = 0; i < 45; i++) {
    await sleep(5000);
    const r = await fetch(`${base}/${name.replace(/^\/+/, "")}?key=${encodeURIComponent(key)}`);
    if (!r.ok) continue;
    const d = await r.json();
    if (d.done) {
      const url = d?.response?.generatedVideos?.[0]?.videoUri;
      if (url) return url;
      throw new Error("Google operation completed without video URL.");
    }
  }
  throw new Error("Google Veo operation timed out.");
}

async function generateReplicate(prompt, imageUrl) {
  const key = process.env.REPLICATE_API_TOKEN;
  const model = process.env.REPLICATE_VIDEO_MODEL || "minimax/video-01";
  const input = { prompt };
  if (imageUrl) input.image = imageUrl;

  const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "wait"
    },
    body: JSON.stringify({ input })
  });

  if (!r.ok) throw new Error(`Replicate HTTP ${r.status}: ${await r.text()}`);

  let p = await r.json();
  while (!["succeeded", "failed", "canceled"].includes(p.status)) {
    await sleep(4000);
    if (!p?.urls?.get) throw new Error("Replicate polling URL missing.");
    const c = await fetch(p.urls.get, { headers: { Authorization: `Bearer ${key}` } });
    if (c.ok) p = await c.json();
  }

  if (p.status === "succeeded") {
    if (Array.isArray(p.output)) return p.output[0];
    if (typeof p.output === "string") return p.output;
    if (p.output?.url) return p.output.url;
  }
  throw new Error(`Replicate failed: ${p.error || p.status}`);
}

async function generateLeonardo(prompt, imageUrl) {
  const key = process.env.LEONARDO_API_KEY;
  const body = { prompt, motionStrength: Number(process.env.LEONARDO_MOTION_STRENGTH) || 5 };
  if (imageUrl) body.imageUrl = imageUrl;

  const r = await fetch("https://cloud.leonardo.ai/api/rest/v1/generations-motion", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error(`Leonardo HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const id = d?.motionGenerationJob?.generationId || d?.generationId;
  if (!id) throw new Error("Leonardo did not return generation ID.");

  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    const c = await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${id}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!c.ok) continue;
    const cd = await c.json();
    const url = cd?.generations_by_pk?.generated_images?.[0]?.motionMP4URL;
    if (url) return url;
  }
  throw new Error("Leonardo timed out.");
}

async function generateKling(prompt, imageUrl, duration) {
  const key = process.env.KLING_API_KEY;
  const body = { prompt, duration: String(duration || 5) };
  if (imageUrl) body.image_url = imageUrl;

  const r = await fetch("https://api.klingai.com/v1/videos/text2video", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error(`Kling HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const taskId = d?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return task_id.");

  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    const c = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!c.ok) continue;
    const cd = await c.json();

    if (cd?.data?.task_status === "succeed")
      return cd?.data?.task_result?.videos?.[0]?.url;
    if (cd?.data?.task_status === "failed") throw new Error("Kling generation failed.");
  }
  throw new Error("Kling timed out.");
}

async function renderWithJSON2Video(rawVideoUrl, options = {}) {
  const key = process.env.JSON2VIDEO_API_KEY;
  if (!key) throw new Error("JSON2VIDEO_API_KEY missing.");

  const elements = [{ type: "video", src: rawVideoUrl, start: 0 }];

  if (options.captionText) {
    elements.push({
      type: "text", text: options.captionText, start: 0,
      duration: Number(options.duration) || 8,
      style: "subtitle", "font-family": "Montserrat",
      "font-size": 32, color: "#00E5FF", y: "80%", x: "center"
    });
  }

  if (options.logoUrl)
    elements.push({ type: "image", src: options.logoUrl, width: 120, x: "90%", y: "10%", opacity: 0.8 });

  if (options.voiceoverText)
    elements.push({ type: "voice", text: options.voiceoverText, voice: "en-US-Neural2-F", start: 0 });

  if (options.musicUrl)
    elements.push({ type: "audio", src: options.musicUrl, volume: 0.3, start: 0 });

  const create = await fetch("https://api.json2video.com/v2/movies", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      resolution: process.env.JSON2VIDEO_RESOLUTION || "full-hd",
      quality: process.env.JSON2VIDEO_QUALITY || "high",
      scenes: [{ elements }]
    })
  });

  if (!create.ok) throw new Error(`JSON2Video HTTP ${create.status}: ${await create.text()}`);

  const project = (await create.json())?.project;
  if (!project) throw new Error("JSON2Video did not return project ID.");

  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const r = await fetch(
      `https://api.json2video.com/v2/movies?project=${encodeURIComponent(project)}`,
      { headers: { "x-api-key": key } }
    );
    if (!r.ok) continue;

    const d = await r.json();
    const movie = d?.movie;
    if (!movie) continue;

    if (movie.url) {
      const credits = movie.consumed_credits != null ? Number(movie.consumed_credits) : null;
      recordJSON2Video(credits);
      return movie.url;
    }

    if (movie.status === "error" || movie.status === "timeout")
      throw new Error(`JSON2Video ${movie.status}: ${movie.message || "render failed"}`);
  }

  throw new Error("JSON2Video render timed out.");
}

app.use((req, res) => res.status(404).json({
  success: false, error: "Endpoint not found.", path: req.path
}));

app.listen(PORT, () => {
  console.log(`Johnny Tec AI Video Backend v${VERSION} running on port ${PORT}`);
});
