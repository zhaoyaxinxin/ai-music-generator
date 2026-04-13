import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { maybeUploadToNetease } from "./netease-uploader.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.join(SCRIPT_DIR, "output");
const DEFAULT_SETTINGS_PATH = path.join(SCRIPT_DIR, "music-settings.json");
const FAILURE_STATUSES = new Set([
  "CREATE_TASK_FAILED",
  "GENERATE_AUDIO_FAILED",
  "SENSITIVE_WORD_ERROR"
]);
const WAV_FAILURE_STATUSES = new Set(["CREATE_TASK_FAILED", "GENERATE_WAV_FAILED"]);
const SUNO_PROMPT_MAX_CHARS = 430;
const SUNO_PROMPT_MAX_WORDS = 80;
const TREND_PRESETS = {
  introspective_pop: {
    label: "Introspective Pop",
    summary: "softer, emotionally direct, lyric-forward pop with intimate arrangement",
    promptDirectives: [
      "Favor emotionally direct writing, intimate lead presence, and restrained arrangement.",
      "Use a memorable chorus with one strong melodic hook, not too many sections.",
      "Keep production polished but human, with dynamic swells and breathable space."
    ]
  },
  afro_fusion: {
    label: "Afro-Fusion",
    summary: "global afro-fusion with warm percussion, melodic bounce, and crossover pop appeal",
    promptDirectives: [
      "Blend Afro-fusion groove, melodic bass movement, and warm percussive swing.",
      "Keep the rhythm danceable but not overcrowded, with clean hooks and crossover accessibility.",
      "Use layered percussion and call-and-response motifs without sounding formulaic."
    ]
  },
  country_pop: {
    label: "Country Pop",
    summary: "hook-driven country-pop with modern drums and cinematic uplift",
    promptDirectives: [
      "Write a strong hook with grounded storytelling and modern country-pop lift.",
      "Use organic guitars or piano with contemporary drums and radio-friendly chorus payoff.",
      "Keep the emotional arc vivid and human instead of generic arena bombast."
    ]
  },
  kpop_polished: {
    label: "K-Pop Polished",
    summary: "precision pop with clean transitions, earworm topline, and high replay value",
    promptDirectives: [
      "Aim for a polished, high-replay pop structure with a sticky topline and sharp transitions.",
      "Use layered production details, tight rhythmic accents, and one standout post-chorus motif.",
      "Keep it sleek and modern, not chaotic or overstuffed."
    ]
  },
  speed_garage: {
    label: "Speed Garage",
    summary: "UK speed garage energy with punchy bass, shuffle, and club momentum",
    promptDirectives: [
      "Use speed garage shuffle, punchy low end, and a direct club-ready pulse.",
      "Keep the groove aggressive but controlled, with crisp drops and vocal chop accents if suitable.",
      "Avoid muddy layering; prioritize movement and impact."
    ]
  },
  triphop_revival: {
    label: "Trip-Hop Revival",
    summary: "moody trip-hop textures, downtempo drums, and smoky atmosphere",
    promptDirectives: [
      "Lean into moody trip-hop atmosphere, downtempo groove, and textured sound design.",
      "Use restrained drums, dark harmonic color, and cinematic negative space.",
      "Keep it sensual and lived-in rather than sterile."
    ]
  }
};
const DEFAULT_SETTINGS = {
  constraints: {
    durationSec: { min: 120, max: 240 },
    audioBitrateKbps: { min: 320 },
    sampleRateHz: { min: 44100 },
    imageWidthPx: { min: 1024, max: 2048 },
    imageHeightPx: { min: 1024, max: 2048 }
  },
  cover: {
    provider: "track",
    onlyWhenTrackImageMissingOrInvalid: false,
    doubao: {
      baseUrl: "https://operator.las.cn-beijing.volces.com",
      model: "doubao-seedream-4-5-251128",
      size: "2048x2048",
      responseFormat: "url",
      watermark: false,
      imageCount: 1
    }
  },
  audioOutput: {
    format: "wav",
    wavPollIntervalSec: 10,
    wavTimeoutSec: 300
  },
  promptEngineering: {
    trendPreset: "introspective_pop",
    avoidAiSound: true,
    humanizationDirectives: [
      "Avoid overly perfect quantization and repetitive loop feel.",
      "Use dynamic contrast, arrangement evolution, and realistic transitions.",
      "Prefer memorable motifs over generic ambient filler.",
      "Keep vocals expressive and human, not robotic or overly synthetic."
    ]
  },
  netease: {
    enabled: false,
    mode: "playwright",
    uploadUrl: "https://music.163.com/#/my/music/cloud/",
    waitForManualLoginSec: 180,
    perTrackTimeoutSec: 180
  }
};

loadEnvFile(path.join(SCRIPT_DIR, ".env"));

class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ApiError";
    this.status = details.status;
    this.apiCode = details.apiCode;
    this.url = details.url;
    this.responseBody = details.responseBody;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.theme) {
    printHelp("Missing required argument: --theme");
    process.exitCode = 1;
    return;
  }

  const config = getConfig();
  const settings = await loadSettings(args.configPath);
  await ensureDir(args.outputDir);

  console.log(`Theme: ${args.theme}`);
  console.log("Step 1/4: Generating a Suno prompt with DeepSeek...");
  const promptPlan = await generatePromptWithDeepSeek({
    theme: args.theme,
    styleHint: args.styleHint,
    lyricsLanguage: args.lyricsLanguage,
    instrumental: args.instrumental,
    constraints: settings.constraints,
    trendPreset: pickCliOverride(args.trendPreset, settings.promptEngineering?.trendPreset),
    promptEngineering: settings.promptEngineering,
    includeCoverPrompt: settings.cover.provider === "doubao",
    deepseekModel: pickCliOverride(args.deepseekModel, config.deepseekModel),
    deepseekBaseUrl: config.deepseekBaseUrl,
    deepseekApiKey: config.deepseekApiKey
  });

  console.log(`DeepSeek title: ${promptPlan.title}`);
  console.log(`DeepSeek prompt: ${promptPlan.suno_prompt}`);
  console.log("Step 2/4: Submitting generation task to Suno...");
  const taskId = await submitSunoTask({
    prompt: promptPlan.suno_prompt,
    instrumental: args.instrumental,
    callbackUrl: pickCliOverride(args.callbackUrl, config.sunoCallbackUrl),
    sunoModel: pickCliOverride(args.sunoModel, config.sunoModel),
    sunoBaseUrl: config.sunoBaseUrl,
    sunoApiKey: config.sunoApiKey,
    sunoAuthMode: config.sunoAuthMode
  });

  console.log(`Task ID: ${taskId}`);
  console.log("Step 3/4: Polling task status until audio URLs are ready...");
  const result = await pollSunoTask({
    taskId,
    timeoutSec: args.timeoutSec,
    pollIntervalSec: args.pollIntervalSec,
    sunoBaseUrl: config.sunoBaseUrl,
    sunoApiKey: config.sunoApiKey,
    sunoAuthMode: config.sunoAuthMode
  });

  const runDir = await createRunDir(args.outputDir, args.theme);
  await ensureDir(runDir);

  const audioFormat = normalizeAudioFormat(pickCliOverride(args.audioFormat, settings.audioOutput?.format || "wav"));
  console.log(`Step 4/4: Downloading ${result.tracks.length} track(s) as ${audioFormat} to ${runDir} ...`);
  let downloadedTracks = [];
  let validation = { hasWarnings: false, warnings: [], tracks: [] };
  let audioQualityGate = buildAudioQualityGate(validation, settings.constraints);
  let generatedCovers = [];
  let neteaseUpload = {
    enabled: Boolean(settings?.netease?.enabled),
    attempted: false,
    uploaded: false,
    skipped: true,
    reason: settings?.netease?.enabled ? "upload_not_started" : "disabled"
  };
  let fatalError = null;

  try {
    downloadedTracks = await downloadTracks(result.tracks, runDir, settings.constraints, {
      audioFormat,
      generationTaskId: taskId,
      wavPollIntervalSec: settings.audioOutput?.wavPollIntervalSec,
      wavTimeoutSec: settings.audioOutput?.wavTimeoutSec,
      sunoBaseUrl: config.sunoBaseUrl,
      sunoApiKey: config.sunoApiKey,
      sunoAuthMode: config.sunoAuthMode
    });
    validation = await validateDownloadedTracks(downloadedTracks, settings.constraints);
    audioQualityGate = buildAudioQualityGate(validation, settings.constraints);
    printValidationSummary(validation);

    if (!audioQualityGate.passed) {
      console.error(audioQualityGate.message);
      throw new Error(audioQualityGate.message);
    }

    generatedCovers = await maybeGenerateReplacementCovers({
      theme: args.theme,
      promptPlan,
      downloadedTracks,
      validation,
      settings,
      config,
      runDir
    });

    neteaseUpload = await maybeUploadToNetease({
      config,
      neteaseSettings: settings.netease,
      promptPlan,
      downloadedTracks,
      validation
    });
  } catch (error) {
    fatalError = serializeError(error);
  }

  const savedFiles = [
    ...downloadedTracks.flatMap((track) => [track.audioPath, track.imagePath].filter(Boolean)),
    ...generatedCovers.map((cover) => cover.path)
  ];

  await writeMetadataFile(
    runDir,
    {
      theme: args.theme,
      styleHint: args.styleHint,
      lyricsLanguage: args.lyricsLanguage,
      instrumental: args.instrumental,
      deepseek: promptPlan,
      settings,
      audioFormat,
      sunoTaskId: taskId,
      sunoStatus: result.status,
      sunoRawData: result.rawData,
      downloads: downloadedTracks.map(serializeDownloadedTrack),
      validation,
      audioQualityGate,
      generatedCovers,
      neteaseUpload,
      savedFiles,
      failure: fatalError
    }
  );

  if (fatalError) {
    process.exitCode = 1;
    throw new Error(fatalError.message);
  }

  console.log("Completed.");
  console.log(`Saved directory: ${runDir}`);
  for (const file of savedFiles) {
    console.log(`- ${file}`);
  }
}

function getConfig() {
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const sunoApiKey = process.env.SUNO_API_KEY?.trim();
  if (!deepseekApiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY. Add it to .env or your shell environment.");
  }
  if (!sunoApiKey) {
    throw new Error("Missing SUNO_API_KEY. Add it to .env or your shell environment.");
  }

  return {
    deepseekApiKey,
    sunoApiKey,
    deepseekBaseUrl: trimTrailingSlash(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"),
    deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    sunoBaseUrl: trimTrailingSlash(process.env.SUNO_BASE_URL || "https://api.sunoapi.org"),
    sunoModel: process.env.SUNO_MODEL || "V4_5ALL",
    sunoCallbackUrl: process.env.SUNO_CALLBACK_URL || "https://example.com/suno-callback",
    sunoAuthMode: process.env.SUNO_AUTH_MODE || "auto",
    neteaseAccountName: process.env.NETEASE_ACCOUNT_NAME?.trim() || "",
    neteaseCookie: process.env.NETEASE_COOKIE?.trim() || "",
    neteaseCookiesPath: process.env.NETEASE_COOKIES_PATH?.trim() || "",
    neteaseStorageStatePath: process.env.NETEASE_STORAGE_STATE_PATH?.trim() || "",
    neteaseBrowserChannel: process.env.NETEASE_BROWSER_CHANNEL?.trim() || "",
    neteaseHeadless: parseBooleanEnv(process.env.NETEASE_HEADLESS, false)
  };
}

function parseArgs(argv) {
  const args = {
    theme: "",
    styleHint: "",
    trendPreset: "",
    lyricsLanguage: "Chinese",
    instrumental: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    audioFormat: "",
    timeoutSec: 420,
    pollIntervalSec: 15,
    callbackUrl: "",
    deepseekModel: "",
    sunoModel: "",
    configPath: DEFAULT_SETTINGS_PATH,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    switch (current) {
      case "--theme":
        args.theme = argv[++i] ?? "";
        break;
      case "--style-hint":
        args.styleHint = argv[++i] ?? "";
        break;
      case "--trend-preset":
        args.trendPreset = argv[++i] ?? "";
        break;
      case "--lyrics-language":
        args.lyricsLanguage = argv[++i] ?? "Chinese";
        break;
      case "--audio-format":
        args.audioFormat = argv[++i] ?? "";
        break;
      case "--output-dir":
        args.outputDir = path.resolve(argv[++i] ?? DEFAULT_OUTPUT_DIR);
        break;
      case "--timeout-sec":
        args.timeoutSec = parsePositiveInt(argv[++i], "--timeout-sec");
        break;
      case "--poll-interval-sec":
        args.pollIntervalSec = parsePositiveInt(argv[++i], "--poll-interval-sec");
        break;
      case "--callback-url":
        args.callbackUrl = argv[++i] ?? "";
        break;
      case "--deepseek-model":
        args.deepseekModel = argv[++i] ?? "";
        break;
      case "--suno-model":
        args.sunoModel = argv[++i] ?? "";
        break;
      case "--config":
        args.configPath = path.resolve(argv[++i] ?? DEFAULT_SETTINGS_PATH);
        break;
      case "--instrumental":
        args.instrumental = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return args;
}

function printHelp(errorMessage = "") {
  if (errorMessage) {
    console.error(errorMessage);
    console.error("");
  }

  console.log(`Usage:
  node index.js --theme "赛博朋克雨夜追逐" [options]

Options:
  --theme <text>              Required. Your song theme.
  --style-hint <text>         Optional. Extra genre/style guidance.
  --trend-preset <name>       Popular-style preset.
  --lyrics-language <text>    Vocal language when not instrumental. Default: Chinese
  --instrumental              Generate instrumental music only.
  --output-dir <path>         Save directory. Default: ./output
  --audio-format <type>       mp3 | wav | both. Default from config.
  --poll-interval-sec <n>     Poll interval in seconds. Default: 15
  --timeout-sec <n>           Timeout in seconds. Default: 420
  --callback-url <url>        Override SUNO_CALLBACK_URL for this run.
  --deepseek-model <name>     Override DEEPSEEK_MODEL for this run.
  --suno-model <name>         Override SUNO_MODEL for this run.
  --config <path>             Path to music-settings.json. Default: ./music-settings.json
  --help, -h                  Show this help.

Examples:
  node index.js --theme "国风武侠大战" --lyrics-language Chinese
  node index.js --theme "Lo-fi coding background music" --instrumental
  node index.js --theme "电影感史诗摇滚" --style-hint "female vocal, huge chorus"
`);
}

async function generatePromptWithDeepSeek({
  theme,
  styleHint,
  trendPreset,
  lyricsLanguage,
  instrumental,
  constraints,
  promptEngineering,
  includeCoverPrompt,
  deepseekModel,
  deepseekBaseUrl,
  deepseekApiKey
}) {
  const selectedTrendPreset = resolveTrendPreset(trendPreset);
  const trendInstructions = buildTrendInstructions(selectedTrendPreset);
  const antiAiInstructions = buildAntiAiInstructions(promptEngineering);
  const schemaFields = [
    '"title":"string"',
    '"suno_prompt":"string"',
    '"style_keywords":["string"]',
    '"creative_notes":"string"'
  ];
  if (includeCoverPrompt) {
    schemaFields.splice(3, 0, '"cover_prompt":"string"');
  }

  const systemPrompt = [
    "You are a music prompt writer for Suno.",
    "You must answer in json.",
    `Return exactly one JSON object with this schema: {${schemaFields.join(",")}}.`,
    "Rules:",
    "- title must be short and specific, maximum 60 characters.",
    `- suno_prompt must be in English, vivid, production-ready, and no more than ${SUNO_PROMPT_MAX_CHARS} characters.`,
    "- style_keywords must contain 3 to 6 short style tags.",
    "- creative_notes must be one short sentence in Chinese.",
    instrumental
      ? "- suno_prompt must clearly ask for instrumental music only, with no vocals and no lyrics."
      : `- suno_prompt must clearly specify ${lyricsLanguage} vocals or lyrics while keeping the rest of the prompt in English.`,
    "- Avoid generic AI-music phrasing such as epic, cinematic, atmospheric, dreamy, emotional unless grounded by concrete arrangement details.",
    "- Prefer concrete instrumentation, groove, vocal delivery, mix texture, arrangement arc, and one memorable hook concept.",
    "- The song should feel contemporary, replayable, and human rather than loop-based or over-quantized.",
    trendInstructions ? `- Current trend direction: ${trendInstructions}` : "",
    antiAiInstructions ? `- Humanization requirements: ${antiAiInstructions}` : "",
    "- Keep the prompt safe and avoid copyrighted lyrics, artist imitation, or banned content.",
    "- The result must stay tightly aligned with the user's theme.",
    buildConstraintPromptLine(constraints),
    includeCoverPrompt
      ? "- cover_prompt must be in English, suitable for an album cover, no text, no logo, and no watermark."
      : ""
  ].join("\n");

  const userPrompt = [
    "Generate one music prompt in json for the following user request.",
    `Theme: ${theme}`,
    `Style hint: ${styleHint || "none"}`,
    `Trend preset: ${selectedTrendPreset ? `${selectedTrendPreset.key} (${selectedTrendPreset.summary})` : "none"}`,
    `Instrumental: ${instrumental ? "yes" : "no"}`,
    `Target lyric language: ${lyricsLanguage}`,
    `Constraints: ${summarizeConstraints(constraints)}`,
    antiAiInstructions ? `Avoid-AI-sound focus: ${antiAiInstructions}` : "",
    includeCoverPrompt ? "Also create one cover image prompt for a square album cover." : ""
  ].join("\n");

  const payload = {
    model: deepseekModel,
    max_tokens: 400,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  let content = "";
  try {
    const data = await postJson(`${deepseekBaseUrl}/chat/completions`, {
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`
      },
      body: {
        ...payload,
        response_format: {
          type: "json_object"
        }
      }
    });
    content = data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (error) {
    const shouldRetryWithoutJsonMode =
      error instanceof ApiError && (error.status === 400 || error.status === 422);
    if (!shouldRetryWithoutJsonMode) {
      throw error;
    }

    console.warn("DeepSeek rejected strict JSON mode. Retrying without response_format...");
    const retryData = await postJson(`${deepseekBaseUrl}/chat/completions`, {
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`
      },
      body: payload
    });
    content = retryData?.choices?.[0]?.message?.content?.trim() || "";
  }

  if (!content) {
    throw new Error("DeepSeek returned empty content. Retry with a slightly different theme or prompt.");
  }

  const parsed = parsePromptPlan(content, theme);
  if (!parsed.title || !parsed.suno_prompt) {
    throw new Error(`DeepSeek response is missing required fields. Raw content: ${content}`);
  }

  const rawSunoPrompt = String(parsed.suno_prompt).trim();
  const finalSunoPrompt = finalizeSunoPrompt(rawSunoPrompt, { instrumental, lyricsLanguage });
  if (finalSunoPrompt !== rawSunoPrompt) {
    console.warn(
      `Compressed Suno prompt from ${rawSunoPrompt.length} to ${finalSunoPrompt.length} characters before submission.`
    );
  }

  return {
    title: String(parsed.title).trim(),
    suno_prompt: finalSunoPrompt,
    suno_prompt_original: rawSunoPrompt,
    style_keywords: Array.isArray(parsed.style_keywords) ? parsed.style_keywords : [],
    cover_prompt: parsed.cover_prompt ? String(parsed.cover_prompt).trim() : buildFallbackCoverPrompt(theme, parsed.title),
    creative_notes: parsed.creative_notes ? String(parsed.creative_notes).trim() : "",
    trend_preset: selectedTrendPreset?.key || ""
  };
}

async function submitSunoTask({
  prompt,
  instrumental,
  callbackUrl,
  sunoModel,
  sunoBaseUrl,
  sunoApiKey,
  sunoAuthMode
}) {
  const payload = {
    customMode: false,
    instrumental,
    model: sunoModel,
    callBackUrl: callbackUrl,
    prompt
  };

  const data = await requestSunoJson({
    url: `${sunoBaseUrl}/api/v1/generate`,
    method: "POST",
    body: payload,
    sunoApiKey,
    sunoAuthMode
  });

  const taskId = data?.data?.taskId;
  if (!taskId) {
    throw new Error(`Suno create-task response did not contain taskId: ${JSON.stringify(data)}`);
  }
  return taskId;
}

async function pollSunoTask({
  taskId,
  timeoutSec,
  pollIntervalSec,
  sunoBaseUrl,
  sunoApiKey,
  sunoAuthMode
}) {
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    const data = await requestSunoJson({
      url: `${sunoBaseUrl}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      method: "GET",
      sunoApiKey,
      sunoAuthMode
    });

    const taskData = data?.data ?? {};
    const status = taskData.status ?? "UNKNOWN";
    const tracks = taskData.response?.sunoData ?? [];
    const readyTracks = tracks.filter(
      (track) => track?.sourceAudioUrl || track?.sourceStreamAudioUrl || track?.audioUrl || track?.streamAudioUrl
    );

    console.log(`Current status: ${status}${readyTracks.length ? ` (${readyTracks.length} track(s) ready)` : ""}`);

    if (FAILURE_STATUSES.has(status)) {
      const message = taskData.errorMessage || data?.msg || `Suno task failed with status ${status}`;
      throw new Error(message);
    }

    if ((status === "SUCCESS" || status === "CALLBACK_EXCEPTION") && readyTracks.length > 0) {
      return {
        status,
        tracks: readyTracks,
        rawData: taskData
      };
    }

    await sleep(pollIntervalSec * 1000);
  }

  throw new Error(`Timed out after ${timeoutSec}s while waiting for Suno task ${taskId}.`);
}

async function downloadTracks(tracks, outputDir, constraints, downloadOptions) {
  const downloadedTracks = [];
  const minBitrateKbps = constraints?.audioBitrateKbps?.min;

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const baseName = `${String(index + 1).padStart(2, "0")}-${sanitizeFilename(track.title || track.id || "track")}`;
    const audioDownload = await downloadRequestedAudio(track, outputDir, baseName, minBitrateKbps, downloadOptions);
    const downloadedTrack = {
      track,
      audioPath: audioDownload.primaryPath,
      imagePath: null,
      audioDownload
    };

    if (track.imageUrl) {
      const imagePath = path.join(outputDir, `${baseName}.jpg`);
      try {
        await downloadFile(track.imageUrl, imagePath);
        downloadedTrack.imagePath = imagePath;
      } catch (error) {
        console.warn(`Skipping cover download for ${baseName}: ${error.message}`);
      }
    }

    downloadedTracks.push(downloadedTrack);
  }

  return downloadedTracks;
}

async function postJson(url, { headers = {}, body }) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return handleJsonResponse(response, url);
}

async function getJson(url, { headers = {} }) {
  const response = await fetch(url, {
    method: "GET",
    headers
  });
  return handleJsonResponse(response, url);
}

async function requestSunoJson({ url, method, body, sunoApiKey, sunoAuthMode }) {
  const attempts = getSunoAuthAttempts(sunoApiKey, sunoAuthMode);
  let lastError;

  for (const attempt of attempts) {
    try {
      if (attempt.label !== "bearer") {
        console.warn(`Suno auth retry with ${attempt.label} header format...`);
      }

      if (method === "POST") {
        return await postJson(url, {
          headers: attempt.headers,
          body
        });
      }

      return await getJson(url, {
        headers: attempt.headers
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || !isUnauthorizedError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function handleJsonResponse(response, url) {
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new ApiError(`Non-JSON response from ${url}: HTTP ${response.status} ${response.statusText}\n${text}`, {
      status: response.status,
      url,
      responseBody: text
    });
  }

  if (!response.ok || (typeof data.code === "number" && data.code !== 200)) {
    const message =
      data?.error?.message ||
      data?.message ||
      data?.msg ||
      data?.error?.type ||
      JSON.stringify(data);
    throw new ApiError(
      `Request failed for ${url}: HTTP ${response.status}, API code ${data.code ?? "unknown"}, message: ${message}`,
      {
        status: response.status,
        apiCode: data.code,
        url,
        responseBody: text
      }
    );
  }

  return data;
}

async function loadSettings(configPath) {
  const filePath = configPath || DEFAULT_SETTINGS_PATH;
  if (!fs.existsSync(filePath)) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  const raw = await fsp.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
}

async function writeMetadataFile(runDir, payload) {
  await fsp.writeFile(path.join(runDir, "metadata.json"), JSON.stringify(payload, null, 2), "utf8");
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return source ?? target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
      target[key] = deepMerge(base, value);
    } else {
      target[key] = value;
    }
  }

  return target;
}

async function validateDownloadedTracks(downloadedTracks, constraints) {
  const tracks = [];
  const warnings = [];

  for (const track of downloadedTracks) {
    const audioAnalysis = await safeAnalyzeAudioFile(track.audioPath, track.track.duration ?? null);
    const imageAnalysis = track.imagePath ? await safeAnalyzeImageFile(track.imagePath) : null;
    const trackWarnings = buildTrackWarnings(audioAnalysis, imageAnalysis, constraints);
    warnings.push(...trackWarnings.map((message) => `${path.basename(track.audioPath)}: ${message}`));

    tracks.push({
      title: track.track.title || "",
      audioPath: track.audioPath,
      imagePath: track.imagePath,
      audio: audioAnalysis,
      image: imageAnalysis,
      warnings: trackWarnings
    });
  }

  return {
    hasWarnings: warnings.length > 0,
    warnings,
    tracks
  };
}

async function safeAnalyzeAudioFile(filePath, fallbackDurationSec) {
  try {
    return await analyzeAudioFile(filePath, fallbackDurationSec);
  } catch (error) {
    return {
      format: "unknown",
      fileSizeBytes: (await fsp.stat(filePath)).size,
      bitrateKbps: null,
      sampleRateHz: null,
      durationSec: fallbackDurationSec ?? null,
      durationSource: fallbackDurationSec ? "suno_api" : "unknown",
      channelMode: null,
      mpegVersion: null,
      variableBitrate: null,
      parseError: error.message
    };
  }
}

async function safeAnalyzeImageFile(filePath) {
  try {
    return await analyzeImageFile(filePath);
  } catch (error) {
    return {
      format: "unknown",
      width: null,
      height: null,
      fileSizeBytes: (await fsp.stat(filePath)).size,
      parseError: error.message
    };
  }
}

function buildAudioQualityGate(validation, constraints) {
  const minBitrateKbps = constraints?.audioBitrateKbps?.min;
  if (typeof minBitrateKbps !== "number") {
    return {
      enforced: false,
      minBitrateKbps: null,
      passed: true,
      failedTracks: [],
      message: ""
    };
  }

  const failedTracks = validation.tracks
    .filter((track) => typeof track.audio?.bitrateKbps !== "number" || track.audio.bitrateKbps < minBitrateKbps)
    .map((track) => ({
      title: track.title,
      audioPath: track.audioPath,
      bitrateKbps: track.audio?.bitrateKbps ?? null
    }));

  const message =
    failedTracks.length > 0
      ? `Audio quality gate failed: ${failedTracks
          .map((track) => `${path.basename(track.audioPath)}=${track.bitrateKbps ?? "unknown"} kbps`)
          .join(", ")}. Required minimum is ${minBitrateKbps} kbps.`
      : "";

  return {
    enforced: true,
    minBitrateKbps,
    passed: failedTracks.length === 0,
    failedTracks,
    message
  };
}

function printValidationSummary(validation) {
  if (!validation.hasWarnings) {
    console.log("Validation: all downloaded tracks satisfy the configured constraints.");
    return;
  }

  console.warn("Validation warnings:");
  for (const warning of validation.warnings) {
    console.warn(`- ${warning}`);
  }
}

function serializeDownloadedTrack(track) {
  return {
    title: track.track?.title || "",
    audioPath: track.audioPath,
    imagePath: track.imagePath,
    mp3Path: track.audioDownload?.mp3Path ?? null,
    wavPath: track.audioDownload?.wavPath ?? null,
    audioDownload: track.audioDownload ?? null
  };
}

function buildTrackWarnings(audioAnalysis, imageAnalysis, constraints) {
  const warnings = [];

  if (audioAnalysis.parseError) {
    warnings.push(`audio metadata parse failed: ${audioAnalysis.parseError}`);
  }
  pushRangeWarning(warnings, "duration", audioAnalysis.durationSec, constraints?.durationSec, "s");
  pushRangeWarning(warnings, "bitrate", audioAnalysis.bitrateKbps, constraints?.audioBitrateKbps, "kbps");

  if (constraints?.sampleRateHz?.min && audioAnalysis.sampleRateHz && audioAnalysis.sampleRateHz < constraints.sampleRateHz.min) {
    warnings.push(`sample rate ${audioAnalysis.sampleRateHz} Hz is below ${constraints.sampleRateHz.min} Hz`);
  }

  if (!imageAnalysis) {
    warnings.push("cover image missing");
    return warnings;
  }

  if (imageAnalysis.parseError) {
    warnings.push(`image metadata parse failed: ${imageAnalysis.parseError}`);
  }
  pushRangeWarning(warnings, "image width", imageAnalysis.width, constraints?.imageWidthPx, "px");
  pushRangeWarning(warnings, "image height", imageAnalysis.height, constraints?.imageHeightPx, "px");
  return warnings;
}

function pushRangeWarning(warnings, label, value, range, unit) {
  if (typeof value !== "number" || !range) {
    return;
  }

  if (typeof range.min === "number" && value < range.min) {
    warnings.push(`${label} ${value} ${unit} is below ${range.min} ${unit}`);
  }
  if (typeof range.max === "number" && value > range.max) {
    warnings.push(`${label} ${value} ${unit} is above ${range.max} ${unit}`);
  }
}

async function analyzeAudioFile(filePath, fallbackDurationSec) {
  const buffer = await fsp.readFile(filePath);
  const stats = await fsp.stat(filePath);
  const audio = parseAudioBuffer(buffer);

  return {
    format: audio.format,
    fileSizeBytes: stats.size,
    bitrateKbps: audio.bitrateKbps,
    sampleRateHz: audio.sampleRateHz,
    durationSec: roundNumber(audio.durationSec ?? fallbackDurationSec ?? 0, 2),
    durationSource: audio.durationSec ? audio.durationSource : fallbackDurationSec ? "suno_api" : "unknown",
    channelMode: audio.channelMode ?? null,
    mpegVersion: audio.mpegVersion ?? null,
    variableBitrate: audio.variableBitrate ?? false,
    bitsPerSample: audio.bitsPerSample ?? null,
    channels: audio.channels ?? null
  };
}

function parseAudioBuffer(buffer) {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    return parseWavBuffer(buffer);
  }
  return parseMp3Buffer(buffer);
}

function parseMp3Buffer(buffer) {
  let offset = 0;
  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "ID3") {
    offset = 10 + readSynchsafeInteger(buffer, 6);
  }

  const frameOffset = findFirstMp3Frame(buffer, offset);
  if (frameOffset < 0) {
    throw new Error(`Unable to parse audio metadata for ${buffer.length} byte file.`);
  }

  const header = parseMp3Header(buffer, frameOffset);
  const xingFrames = readXingFrameCount(buffer, frameOffset, header);
  const vbriFrames = readVbriFrameCount(buffer, frameOffset);
  const totalFrames = xingFrames ?? vbriFrames ?? null;
  const audioBytes = buffer.length - frameOffset;
  const durationSec =
    totalFrames !== null
      ? (totalFrames * header.samplesPerFrame) / header.sampleRateHz
      : (audioBytes * 8) / (header.bitrateKbps * 1000);

  return {
    format: "mp3",
    bitrateKbps: header.bitrateKbps,
    sampleRateHz: header.sampleRateHz,
    durationSec,
    durationSource: totalFrames !== null ? "frame_count" : "bitrate_estimate",
    channelMode: header.channelMode,
    mpegVersion: header.mpegVersion,
    variableBitrate: totalFrames !== null
  };
}

function parseWavBuffer(buffer) {
  let offset = 12;
  let audioFormat = null;
  let channels = null;
  let sampleRateHz = null;
  let byteRate = null;
  let bitsPerSample = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16 && chunkDataOffset + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      sampleRateHz = buffer.readUInt32LE(chunkDataOffset + 4);
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!sampleRateHz || !channels || !bitsPerSample) {
    throw new Error("Invalid WAV header");
  }

  const bitrateKbps = roundNumber((byteRate * 8) / 1000, 2);
  const durationSec = dataSize && byteRate ? dataSize / byteRate : null;
  return {
    format: audioFormat === 3 ? "wav_float" : "wav",
    bitrateKbps,
    sampleRateHz,
    durationSec,
    durationSource: "wav_header",
    channelMode: channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}ch`,
    mpegVersion: null,
    variableBitrate: false,
    bitsPerSample,
    channels
  };
}

function findFirstMp3Frame(buffer, startOffset) {
  for (let offset = startOffset; offset < buffer.length - 4; offset += 1) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      continue;
    }

    try {
      parseMp3Header(buffer, offset);
      return offset;
    } catch {
      continue;
    }
  }
  return -1;
}

function parseMp3Header(buffer, offset) {
  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];
  const b3 = buffer[offset + 3];
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const protectionBit = b1 & 0x01;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const channelModeBits = (b3 >> 6) & 0x03;

  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    throw new Error("Invalid MP3 header");
  }

  const mpegVersion = versionBits === 3 ? "1" : versionBits === 2 ? "2" : "2.5";
  const layer = layerBits === 3 ? "I" : layerBits === 2 ? "II" : "III";
  const bitrateKbps = getMp3BitrateKbps(mpegVersion, layer, bitrateIndex);
  const sampleRateHz = getMp3SampleRateHz(versionBits, sampleRateIndex);
  const samplesPerFrame = getSamplesPerFrame(mpegVersion, layer);
  const channelMode = ["stereo", "joint_stereo", "dual_channel", "mono"][channelModeBits];

  return {
    bitrateKbps,
    sampleRateHz,
    samplesPerFrame,
    channelMode,
    mpegVersion,
    layer,
    hasCrc: protectionBit === 0
  };
}

function getMp3BitrateKbps(mpegVersion, layer, bitrateIndex) {
  const tables = {
    V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    V2L2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };

  if (mpegVersion === "1" && layer === "I") return tables.V1L1[bitrateIndex];
  if (mpegVersion === "1" && layer === "II") return tables.V1L2[bitrateIndex];
  if (mpegVersion === "1" && layer === "III") return tables.V1L3[bitrateIndex];
  if (mpegVersion !== "1" && layer === "I") return tables.V2L1[bitrateIndex];
  return tables.V2L2L3[bitrateIndex];
}

function getMp3SampleRateHz(versionBits, sampleRateIndex) {
  const base = [44100, 48000, 32000][sampleRateIndex];
  if (versionBits === 3) return base;
  if (versionBits === 2) return base / 2;
  return base / 4;
}

function getSamplesPerFrame(mpegVersion, layer) {
  if (layer === "I") return 384;
  if (layer === "II") return 1152;
  return mpegVersion === "1" ? 1152 : 576;
}

function readXingFrameCount(buffer, frameOffset, header) {
  const sideInfoSize =
    header.layer !== "III"
      ? 0
      : header.mpegVersion === "1"
        ? header.channelMode === "mono"
          ? 17
          : 32
        : header.channelMode === "mono"
          ? 9
          : 17;
  const xingOffset = frameOffset + 4 + (header.hasCrc ? 2 : 0) + sideInfoSize;
  if (xingOffset + 12 >= buffer.length) {
    return null;
  }

  const marker = buffer.toString("ascii", xingOffset, xingOffset + 4);
  if (marker !== "Xing" && marker !== "Info") {
    return null;
  }

  const flags = buffer.readUInt32BE(xingOffset + 4);
  if ((flags & 0x0001) === 0) {
    return null;
  }
  return buffer.readUInt32BE(xingOffset + 8);
}

function readVbriFrameCount(buffer, frameOffset) {
  const vbriOffset = frameOffset + 36;
  if (vbriOffset + 18 >= buffer.length) {
    return null;
  }
  if (buffer.toString("ascii", vbriOffset, vbriOffset + 4) !== "VBRI") {
    return null;
  }
  return buffer.readUInt32BE(vbriOffset + 14);
}

async function analyzeImageFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  const stats = await fsp.stat(filePath);
  const info = parseImageSize(buffer);
  return {
    format: info.format,
    width: info.width,
    height: info.height,
    fileSizeBytes: stats.size
  };
}

function parseImageSize(buffer) {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return {
      format: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return {
      format: "gif",
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      while (buffer[offset] === 0xff) {
        offset += 1;
      }
      const marker = buffer[offset];
      offset += 1;

      if (marker === 0xd8 || marker === 0xd9) {
        continue;
      }

      const blockLength = buffer.readUInt16BE(offset);
      if (blockLength < 2) {
        break;
      }

      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf
      ) {
        return {
          format: "jpeg",
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5)
        };
      }

      offset += blockLength;
    }
  }

  throw new Error("Unsupported image format for dimension parsing.");
}

async function maybeGenerateReplacementCovers({
  theme,
  promptPlan,
  downloadedTracks,
  validation,
  settings,
  config,
  runDir
}) {
  if (settings?.cover?.provider !== "doubao") {
    return [];
  }

  const doubaoApiKey = process.env.DOUBAO_IMAGE_API_KEY?.trim();
  if (!doubaoApiKey) {
    throw new Error("Cover provider is set to doubao, but DOUBAO_IMAGE_API_KEY is missing.");
  }

  const outputs = [];
  const limit = Math.max(1, Number.parseInt(settings.cover.doubao.imageCount ?? downloadedTracks.length, 10) || 1);

  for (let index = 0; index < downloadedTracks.length; index += 1) {
    if (outputs.length >= limit) {
      break;
    }

    const validationEntry = validation.tracks[index];
    const needsReplacement =
      !settings.cover.onlyWhenTrackImageMissingOrInvalid ||
      validationEntry.warnings.some((warning) => warning.includes("cover") || warning.includes("image "));
    if (!needsReplacement) {
      continue;
    }

    const track = downloadedTracks[index];
    const prompt = buildDoubaoCoverPrompt(theme, promptPlan, track.track.title || promptPlan.title);
    const imageUrl = await generateDoubaoImage({
      prompt,
      doubaoApiKey,
      doubaoSettings: settings.cover.doubao
    });

    const filePath = path.join(runDir, `cover-${String(index + 1).padStart(2, "0")}-${sanitizeFilename(track.track.title || promptPlan.title)}.jpg`);
    await downloadFile(imageUrl, filePath);
    const image = await analyzeImageFile(filePath);
    outputs.push({
      provider: "doubao",
      path: filePath,
      prompt,
      image
    });
  }

  return outputs;
}

function buildDoubaoCoverPrompt(theme, promptPlan, title) {
  const fragments = [
    promptPlan.cover_prompt || buildFallbackCoverPrompt(theme, title),
    `Theme: ${sanitizePromptText(theme)}`,
    `Track title: ${sanitizePromptText(title)}`,
    "Album cover art, no text, no logo, no watermark."
  ];
  return fragments.join(" ");
}

async function generateDoubaoImage({ prompt, doubaoApiKey, doubaoSettings }) {
  const baseUrl = trimTrailingSlash(doubaoSettings.baseUrl || DEFAULT_SETTINGS.cover.doubao.baseUrl);
  const payload = {
    model: doubaoSettings.model || DEFAULT_SETTINGS.cover.doubao.model,
    prompt,
    size: doubaoSettings.size || DEFAULT_SETTINGS.cover.doubao.size,
    response_format: doubaoSettings.responseFormat || DEFAULT_SETTINGS.cover.doubao.responseFormat,
    watermark: doubaoSettings.watermark ?? DEFAULT_SETTINGS.cover.doubao.watermark
  };

  const data = await postJson(`${baseUrl}/api/v1/images/generations`, {
    headers: {
      Authorization: `Bearer ${doubaoApiKey}`
    },
    body: payload
  });

  const imageUrl = data?.data?.[0]?.url;
  if (!imageUrl) {
    throw new Error(`Doubao image API did not return an image URL: ${JSON.stringify(data)}`);
  }
  return imageUrl;
}

function getSunoAuthAttempts(sunoApiKey, sunoAuthMode) {
  const normalized = String(sunoAuthMode || "auto").trim().toLowerCase();
  const attempts = [];

  const push = (label, headers) => {
    if (!attempts.some((attempt) => attempt.label === label)) {
      attempts.push({ label, headers });
    }
  };

  if (normalized === "bearer" || normalized === "auto") {
    push("bearer", { Authorization: `Bearer ${sunoApiKey}` });
  }
  if (normalized === "raw" || normalized === "auto") {
    push("raw", { Authorization: sunoApiKey });
  }
  if (normalized === "x-api-key" || normalized === "x_api_key" || normalized === "auto") {
    push("x-api-key", { "X-API-Key": sunoApiKey });
  }

  if (attempts.length === 0) {
    throw new Error(`Unsupported SUNO_AUTH_MODE: ${sunoAuthMode}`);
  }

  return attempts;
}

function isUnauthorizedError(error) {
  return error.status === 401 || error.apiCode === 401 || /unauthorized/i.test(error.message);
}

function parsePromptPlan(content, theme) {
  try {
    return JSON.parse(content);
  } catch {
    const matched = content.match(/\{[\s\S]*\}/u);
    if (matched) {
      try {
        return JSON.parse(matched[0]);
      } catch {
        return buildFallbackPromptPlan(theme, content);
      }
    }

    return buildFallbackPromptPlan(theme, content);
  }
}

function buildFallbackPromptPlan(theme, content) {
  return {
    title: theme.slice(0, 60),
    suno_prompt: String(content).trim().replace(/\s+/gu, " ").slice(0, 380),
    style_keywords: [],
    cover_prompt: buildFallbackCoverPrompt(theme, theme),
    creative_notes: "DeepSeek returned non-JSON text, so the raw output was used as the Suno prompt."
  };
}

function buildFallbackCoverPrompt(theme, title) {
  const subject = sanitizePromptText(title || theme || "music cover");
  return `Album cover artwork for "${subject}", cinematic atmosphere, high detail, no text, no logo, no watermark.`;
}

function resolveTrendPreset(key) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  if (!normalized) {
    return null;
  }

  const preset = TREND_PRESETS[normalized];
  return preset ? { key: normalized, ...preset } : null;
}

function buildTrendInstructions(preset) {
  if (!preset) {
    return "";
  }
  return [preset.summary, ...preset.promptDirectives].join(" ");
}

function buildAntiAiInstructions(promptEngineering) {
  if (!promptEngineering?.avoidAiSound) {
    return "";
  }

  const directives = Array.isArray(promptEngineering.humanizationDirectives)
    ? promptEngineering.humanizationDirectives.map((item) => String(item).trim()).filter(Boolean)
    : [];

  return directives.join(" ");
}

function finalizeSunoPrompt(prompt, { instrumental, lyricsLanguage }) {
  const normalized = compactWhitespace(prompt)
    .replace(/[;|]+/gu, ", ")
    .replace(/\s*,\s*/gu, ", ")
    .replace(/\s+/gu, " ")
    .trim();

  let compacted = normalized;
  if (countWords(compacted) > SUNO_PROMPT_MAX_WORDS || compacted.length > SUNO_PROMPT_MAX_CHARS) {
    compacted = compactSunoPrompt(compacted);
  }

  compacted = ensurePromptRequirement(compacted, { instrumental, lyricsLanguage });

  if (countWords(compacted) > SUNO_PROMPT_MAX_WORDS || compacted.length > SUNO_PROMPT_MAX_CHARS) {
    compacted = hardTrimPrompt(compacted);
  }

  return compacted;
}

function compactSunoPrompt(prompt) {
  const sentences = prompt
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const selected = [];
  for (const sentence of sentences) {
    const candidate = compactWhitespace([...selected, sentence].join(" "));
    if (candidate.length > SUNO_PROMPT_MAX_CHARS || countWords(candidate) > SUNO_PROMPT_MAX_WORDS) {
      break;
    }
    selected.push(sentence);
  }

  if (selected.length > 0) {
    return compactWhitespace(selected.join(" "));
  }

  return hardTrimPrompt(prompt);
}

function ensurePromptRequirement(prompt, { instrumental, lyricsLanguage }) {
  let output = prompt;

  if (instrumental) {
    if (!/\binstrumental\b/i.test(output)) {
      output = `Instrumental track, ${output}`;
    }
    if (!/\bno vocals\b/i.test(output) && !/\bno lyrics\b/i.test(output)) {
      output = `${output}, no vocals, no lyrics`;
    }
  } else {
    const vocalRequirement = `${lyricsLanguage} vocals`;
    if (!new RegExp(`\\b${escapeRegExp(lyricsLanguage)}\\b`, "i").test(output)) {
      output = `${output}, ${vocalRequirement}`;
    }
  }

  return compactWhitespace(output).replace(/\s*,\s*/gu, ", ");
}

function hardTrimPrompt(prompt) {
  const words = compactWhitespace(prompt).split(" ").filter(Boolean).slice(0, SUNO_PROMPT_MAX_WORDS);
  let trimmed = words.join(" ");

  if (trimmed.length > SUNO_PROMPT_MAX_CHARS) {
    trimmed = trimmed.slice(0, SUNO_PROMPT_MAX_CHARS);
    const lastComma = trimmed.lastIndexOf(",");
    const lastSpace = trimmed.lastIndexOf(" ");
    const cutIndex = Math.max(lastComma, lastSpace);
    if (cutIndex >= 120) {
      trimmed = trimmed.slice(0, cutIndex);
    }
  }

  return trimmed.replace(/[,\s]+$/u, "").trim();
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function countWords(value) {
  const normalized = compactWhitespace(value);
  return normalized ? normalized.split(" ").length : 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function buildConstraintPromptLine(constraints) {
  return `- Aim for these target constraints where possible: ${summarizeConstraints(constraints)}.`;
}

function summarizeConstraints(constraints) {
  const parts = [];

  const duration = constraints?.durationSec;
  if (duration?.min || duration?.max) {
    parts.push(`duration ${formatRange(duration.min, duration.max, "s")}`);
  }

  const bitrate = constraints?.audioBitrateKbps;
  if (bitrate?.min || bitrate?.max) {
    parts.push(`bitrate ${formatRange(bitrate.min, bitrate.max, "kbps")}`);
  }

  const sampleRate = constraints?.sampleRateHz;
  if (sampleRate?.min) {
    parts.push(`sample rate >= ${sampleRate.min} Hz`);
  }

  const width = constraints?.imageWidthPx;
  const height = constraints?.imageHeightPx;
  if (width?.min || width?.max || height?.min || height?.max) {
    parts.push(
      `cover size width ${formatRange(width?.min, width?.max, "px")} and height ${formatRange(
        height?.min,
        height?.max,
        "px"
      )}`
    );
  }

  return parts.length > 0 ? parts.join(", ") : "no extra constraints";
}

function formatRange(min, max, unit) {
  if (min && max) {
    return `${min}-${max} ${unit}`;
  }
  if (min) {
    return `>= ${min} ${unit}`;
  }
  if (max) {
    return `<= ${max} ${unit}`;
  }
  return `unspecified ${unit}`;
}

async function downloadRequestedAudio(track, outputDir, baseName, minBitrateKbps, downloadOptions) {
  const format = normalizeAudioFormat(downloadOptions?.audioFormat);
  const mp3Path = path.join(outputDir, `${baseName}.mp3`);
  const wavPath = path.join(outputDir, `${baseName}.wav`);

  if (format === "mp3") {
    const mp3Download = await downloadBestAudioVariant(track, mp3Path, minBitrateKbps);
    return {
      format,
      primaryPath: mp3Path,
      mp3Path,
      wavPath: null,
      mp3Download,
      wavDownload: null
    };
  }

  if (format === "wav") {
    const wavDownload = await downloadWavVariant(track, wavPath, downloadOptions);
    return {
      format,
      primaryPath: wavPath,
      mp3Path: null,
      wavPath,
      mp3Download: null,
      wavDownload
    };
  }

  const mp3Download = await downloadBestAudioVariant(track, mp3Path, minBitrateKbps);
  const wavDownload = await downloadWavVariant(track, wavPath, downloadOptions);
  return {
    format,
    primaryPath: wavPath,
    mp3Path,
    wavPath,
    mp3Download,
    wavDownload
  };
}

function normalizeAudioFormat(value) {
  const normalized = String(value || "wav").trim().toLowerCase();
  if (normalized === "mp3" || normalized === "wav" || normalized === "both") {
    return normalized;
  }
  throw new Error(`Unsupported audio format: ${value}. Use mp3, wav, or both.`);
}

async function downloadWavVariant(track, wavPath, downloadOptions) {
  const convertTaskId = await submitWavTask({
    generationTaskId: downloadOptions.generationTaskId,
    audioId: track.id,
    sunoBaseUrl: downloadOptions.sunoBaseUrl,
    sunoApiKey: downloadOptions.sunoApiKey,
    sunoAuthMode: downloadOptions.sunoAuthMode
  });

  const wavInfo = await pollWavTask({
    taskId: convertTaskId,
    timeoutSec: downloadOptions.wavTimeoutSec,
    pollIntervalSec: downloadOptions.wavPollIntervalSec,
    sunoBaseUrl: downloadOptions.sunoBaseUrl,
    sunoApiKey: downloadOptions.sunoApiKey,
    sunoAuthMode: downloadOptions.sunoAuthMode
  });

  await downloadFile(wavInfo.wavUrl, wavPath);
  const analysis = await safeAnalyzeAudioFile(wavPath, track.duration ?? null);
  return {
    convertTaskId,
    wavUrl: wavInfo.wavUrl,
    source: wavInfo.source,
    analysis
  };
}

async function submitWavTask({ generationTaskId, audioId, sunoBaseUrl, sunoApiKey, sunoAuthMode }) {
  if (!generationTaskId || !audioId) {
    throw new Error("WAV conversion requires both the original generation taskId and track audioId from Suno.");
  }

  const data = await requestSunoJson({
    url: `${sunoBaseUrl}/api/v1/wav/generate`,
    method: "POST",
    body: { taskId: generationTaskId, audioId },
    sunoApiKey,
    sunoAuthMode
  });

  const taskId = data?.data?.taskId;
  if (!taskId) {
    throw new Error(`Suno wav generate response did not contain taskId: ${JSON.stringify(data)}`);
  }
  return taskId;
}

async function pollWavTask({ taskId, timeoutSec, pollIntervalSec, sunoBaseUrl, sunoApiKey, sunoAuthMode }) {
  const deadline = Date.now() + (timeoutSec || 300) * 1000;

  while (Date.now() < deadline) {
    const data = await requestSunoJson({
      url: `${sunoBaseUrl}/api/v1/wav/record-info?taskId=${encodeURIComponent(taskId)}`,
      method: "GET",
      sunoApiKey,
      sunoAuthMode
    });

    const taskData = data?.data ?? {};
    const status = taskData.successFlag ?? taskData.status ?? "UNKNOWN";
    const wavUrl =
      taskData.response?.audioWavUrl ||
      taskData.response?.wavUrl ||
      taskData.response?.data?.wavUrl ||
      taskData.wavUrl ||
      taskData.response?.downloadUrl ||
      "";

    console.log(`Current WAV status: ${status}${wavUrl ? " (wav ready)" : ""}`);

    if (WAV_FAILURE_STATUSES.has(status) || status === false || status === "FAILED") {
      const message = taskData.errorMessage || data?.msg || `Suno WAV task failed with status ${status}`;
      throw new Error(message);
    }

    if ((status === "SUCCESS" || status === "CALLBACK_EXCEPTION" || status === true) && wavUrl) {
      return {
        wavUrl,
        source: taskData
      };
    }

    await sleep((pollIntervalSec || 10) * 1000);
  }

  throw new Error(`Timed out after ${timeoutSec || 300}s while waiting for Suno WAV task ${taskId}.`);
}

async function downloadBestAudioVariant(track, audioPath, minBitrateKbps) {
  const candidates = getAudioDownloadCandidates(track);
  if (candidates.length === 0) {
    throw new Error(`Track ${track.title || track.id || "unknown"} does not contain any downloadable audio URL.`);
  }

  let bestAttempt = null;
  let selectedTempPath = "";

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const tempPath = `${audioPath}.candidate-${index + 1}.tmp`;
    let attempt;

    try {
      await downloadFile(candidate.url, tempPath);
      const analysis = await safeAnalyzeAudioFile(tempPath, track.duration ?? null);
      attempt = {
        label: candidate.label,
        url: candidate.url,
        bitrateKbps: analysis.bitrateKbps,
        fileSizeBytes: analysis.fileSizeBytes,
        parseError: analysis.parseError ?? null
      };

      if (!bestAttempt || compareDownloadAttempts(attempt, bestAttempt) > 0) {
        if (selectedTempPath && selectedTempPath !== tempPath) {
          await deleteFileIfExists(selectedTempPath);
        }
        bestAttempt = attempt;
        selectedTempPath = tempPath;
      } else {
        await deleteFileIfExists(tempPath);
      }

      candidate.attempt = attempt;
      if (typeof minBitrateKbps === "number" && typeof analysis.bitrateKbps === "number" && analysis.bitrateKbps >= minBitrateKbps) {
        break;
      }
    } catch (error) {
      attempt = {
        label: candidate.label,
        url: candidate.url,
        bitrateKbps: null,
        fileSizeBytes: null,
        parseError: error.message
      };
      await deleteFileIfExists(tempPath);
      if (!bestAttempt) {
        bestAttempt = attempt;
      }
    }

    candidate.attempt = attempt;
  }

  const attempts = candidates.map((candidate) => candidate.attempt).filter(Boolean);
  if (!selectedTempPath) {
    throw new Error(
      `Failed to download any usable audio for ${track.title || track.id || "unknown"}: ${attempts
        .map((attempt) => `${attempt.label}=${attempt.parseError || "unknown error"}`)
        .join("; ")}`
    );
  }

  await fsp.rename(selectedTempPath, audioPath);
  return {
    selected: bestAttempt,
    attempts
  };
}

function getAudioDownloadCandidates(track) {
  const entries = [
    ["sourceAudioUrl", track.sourceAudioUrl],
    ["sourceStreamAudioUrl", track.sourceStreamAudioUrl],
    ["audioUrl", track.audioUrl],
    ["streamAudioUrl", track.streamAudioUrl]
  ];
  const seen = new Set();
  const candidates = [];

  for (const [label, url] of entries) {
    const normalized = String(url || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push({ label, url: normalized });
  }

  return candidates;
}

function compareDownloadAttempts(left, right) {
  const leftBitrate = Number.isFinite(left?.bitrateKbps) ? left.bitrateKbps : -1;
  const rightBitrate = Number.isFinite(right?.bitrateKbps) ? right.bitrateKbps : -1;
  if (leftBitrate !== rightBitrate) {
    return leftBitrate - rightBitrate;
  }

  const leftSize = Number.isFinite(left?.fileSizeBytes) ? left.fileSizeBytes : -1;
  const rightSize = Number.isFinite(right?.fileSizeBytes) ? right.fileSizeBytes : -1;
  return leftSize - rightSize;
}

async function downloadFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(filePath, buffer);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    value = value.replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function sanitizeFilename(input) {
  const cleaned = String(input)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 80);

  return cleaned || "untitled";
}

function sanitizePromptText(input) {
  return String(input || "")
    .replace(/\s+/gu, " ")
    .replace(/["]+/gu, "'")
    .trim()
    .slice(0, 200);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function parsePositiveInt(value, argName) {
  const number = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${argName} must be a positive integer.`);
  }
  return number;
}

function pickCliOverride(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readSynchsafeInteger(buffer, offset) {
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
}

function roundNumber(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function createRunDir(outputDir, theme) {
  const datePrefix = formatDateForDir(new Date());
  const themePart = sanitizeFilename(theme || "music-task");
  const existingNames = new Set();

  try {
    const entries = await fsp.readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingNames.add(entry.name);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  let sequence = 1;
  while (true) {
    const candidateName = `${datePrefix}-${themePart}-${String(sequence).padStart(3, "0")}`;
    if (!existingNames.has(candidateName)) {
      return path.join(outputDir, candidateName);
    }
    sequence += 1;
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDateForDir(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseBooleanEnv(value, defaultValue) {
  if (typeof value !== "string" || !value.trim()) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

async function deleteFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || ""
  };
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
