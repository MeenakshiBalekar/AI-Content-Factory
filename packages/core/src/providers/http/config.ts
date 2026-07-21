/**
 * Provider configuration resolved from environment variables. Keeping this in one place means
 * credentials never leak into domain code and the CLI/API can decide at startup which
 * capabilities have a real provider vs. fall back to the offline LocalProvider.
 */

export interface OpenAITextConfig {
  readonly apiKey: string;
  readonly baseUrl: string; // OpenAI-compatible; override for Azure/together/groq/etc.
  readonly model: string;
}

export interface OpenAIImageConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface ElevenLabsConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
}

export interface AsyncVideoConfig {
  readonly apiKey: string;
  readonly submitUrl: string; // POST -> { id }
  readonly statusUrlTemplate: string; // GET, contains "{id}" -> { status, url }
  readonly model: string;
  readonly pollIntervalMs: number;
  readonly maxPollMs: number;
}

export interface ProvidersConfig {
  readonly text?: OpenAITextConfig;
  readonly image?: OpenAIImageConfig;
  readonly audio?: ElevenLabsConfig;
  readonly video?: AsyncVideoConfig;
}

type Env = Record<string, string | undefined>;

const val = (env: Env, key: string): string | undefined => {
  const v = env[key];
  return v && v.trim() ? v.trim() : undefined;
};

/** Build config from an env bag (defaults to process.env). Only capabilities whose required
 *  keys are present are populated; everything else is left undefined for fallback. */
export function loadProvidersConfig(env: Env = process.env): ProvidersConfig {
  const cfg: {
    text?: OpenAITextConfig;
    image?: OpenAIImageConfig;
    audio?: ElevenLabsConfig;
    video?: AsyncVideoConfig;
  } = {};

  const openaiKey = val(env, "OPENAI_API_KEY");
  if (openaiKey) {
    const baseUrl = val(env, "OPENAI_BASE_URL") ?? "https://api.openai.com";
    cfg.text = { apiKey: openaiKey, baseUrl, model: val(env, "ACF_TEXT_MODEL") ?? "gpt-4o-mini" };
    cfg.image = { apiKey: openaiKey, baseUrl, model: val(env, "ACF_IMAGE_MODEL") ?? "gpt-image-1" };
  }

  const elevenKey = val(env, "ELEVENLABS_API_KEY");
  if (elevenKey) {
    cfg.audio = {
      apiKey: elevenKey,
      baseUrl: val(env, "ELEVENLABS_BASE_URL") ?? "https://api.elevenlabs.io",
      modelId: val(env, "ACF_TTS_MODEL") ?? "eleven_multilingual_v2",
    };
  }

  const videoKey = val(env, "ACF_VIDEO_API_KEY");
  const submitUrl = val(env, "ACF_VIDEO_SUBMIT_URL");
  const statusUrlTemplate = val(env, "ACF_VIDEO_STATUS_URL");
  if (videoKey && submitUrl && statusUrlTemplate) {
    cfg.video = {
      apiKey: videoKey,
      submitUrl,
      statusUrlTemplate,
      model: val(env, "ACF_VIDEO_MODEL") ?? "veo-3.1-fast",
      pollIntervalMs: Number(val(env, "ACF_VIDEO_POLL_MS") ?? "5000"),
      maxPollMs: Number(val(env, "ACF_VIDEO_MAX_POLL_MS") ?? "600000"),
    };
  }

  return cfg;
}
