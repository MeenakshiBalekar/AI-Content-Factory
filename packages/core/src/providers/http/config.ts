/**
 * Provider configuration — SELF-HOSTED FIRST.
 *
 * The platform never depends on commercial AI APIs. Every capability is served by an
 * OpenAI-compatible *protocol* endpoint — an open standard implemented by the self-hosted
 * inference stack (vLLM, Ollama, LocalAI, ComfyUI bridges, Kokoro-FastAPI, Speaches):
 *
 *   text   → ACF_TEXT_BASE_URL    (vLLM / Ollama serving Llama, Qwen, Mistral, …)
 *   image  → ACF_IMAGE_BASE_URL   (LocalAI / SD-WebUI serving FLUX.1, SDXL, SD3.5, …)
 *   speech → ACF_SPEECH_BASE_URL  (Kokoro-FastAPI / Speaches serving Kokoro, XTTS, Piper)
 *   video  → ACF_VIDEO_SUBMIT_URL + ACF_VIDEO_STATUS_URL (our render queue in front of
 *            ComfyUI running LTX-Video / Wan / HunyuanVideo / CogVideoX)
 *
 * API keys are OPTIONAL — local servers usually need none. Commercial endpoints happen to
 * speak the same protocol, so they still *work* through the same adapters (useful for
 * one-off comparisons), but they are a legacy fallback, never a dependency: nothing in the
 * platform requires them, and the factory always prefers the self-hosted configuration.
 */

export type ProviderMode = "self-hosted" | "commercial";

export interface ChatTextConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string; // optional: local inference servers are keyless
  readonly mode: ProviderMode;
}

export interface ImageGenConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly mode: ProviderMode;
}

export interface SpeechConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly mode: ProviderMode;
}

/** Commercial TTS fallback (legacy) — kept only because it hides behind the same
 *  AudioProvider interface; the platform never requires it. */
export interface ElevenLabsConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
}

export interface AsyncVideoConfig {
  readonly submitUrl: string; // POST -> { id }
  readonly statusUrlTemplate: string; // GET, contains "{id}" -> { status, url }
  readonly model: string;
  readonly apiKey?: string; // optional: our own render queue is keyless
  readonly pollIntervalMs: number;
  readonly maxPollMs: number;
  readonly mode: ProviderMode;
}

export interface ProvidersConfig {
  readonly text?: ChatTextConfig;
  readonly image?: ImageGenConfig;
  readonly speech?: SpeechConfig;
  readonly elevenlabs?: ElevenLabsConfig;
  readonly video?: AsyncVideoConfig;
}

type Env = Record<string, string | undefined>;

const val = (env: Env, key: string): string | undefined => {
  const v = env[key];
  return v && v.trim() ? v.trim() : undefined;
};

/** Build config from an env bag (defaults to process.env). Self-hosted endpoints
 *  (ACF_*_BASE_URL) always win over commercial fallbacks. */
export function loadProvidersConfig(env: Env = process.env): ProvidersConfig {
  const cfg: {
    text?: ChatTextConfig;
    image?: ImageGenConfig;
    speech?: SpeechConfig;
    elevenlabs?: ElevenLabsConfig;
    video?: AsyncVideoConfig;
  } = {};

  // --- text ---
  const textBase = val(env, "ACF_TEXT_BASE_URL");
  const openaiKey = val(env, "OPENAI_API_KEY");
  if (textBase) {
    cfg.text = {
      baseUrl: textBase,
      model: val(env, "ACF_TEXT_MODEL") ?? "llama3.1:8b",
      ...(val(env, "ACF_TEXT_API_KEY") ? { apiKey: val(env, "ACF_TEXT_API_KEY")! } : {}),
      mode: "self-hosted",
    };
  } else if (openaiKey) {
    cfg.text = {
      baseUrl: val(env, "OPENAI_BASE_URL") ?? "https://api.openai.com",
      model: val(env, "ACF_TEXT_MODEL") ?? "gpt-4o-mini",
      apiKey: openaiKey,
      mode: "commercial",
    };
  }

  // --- image ---
  const imageBase = val(env, "ACF_IMAGE_BASE_URL");
  if (imageBase) {
    cfg.image = {
      baseUrl: imageBase,
      model: val(env, "ACF_IMAGE_MODEL") ?? "flux.1-schnell",
      ...(val(env, "ACF_IMAGE_API_KEY") ? { apiKey: val(env, "ACF_IMAGE_API_KEY")! } : {}),
      mode: "self-hosted",
    };
  } else if (openaiKey) {
    cfg.image = {
      baseUrl: val(env, "OPENAI_BASE_URL") ?? "https://api.openai.com",
      model: val(env, "ACF_IMAGE_MODEL") ?? "gpt-image-1",
      apiKey: openaiKey,
      mode: "commercial",
    };
  }

  // --- speech / audio ---
  const speechBase = val(env, "ACF_SPEECH_BASE_URL");
  if (speechBase) {
    cfg.speech = {
      baseUrl: speechBase,
      model: val(env, "ACF_SPEECH_MODEL") ?? "kokoro",
      ...(val(env, "ACF_SPEECH_API_KEY") ? { apiKey: val(env, "ACF_SPEECH_API_KEY")! } : {}),
      mode: "self-hosted",
    };
  }
  const elevenKey = val(env, "ELEVENLABS_API_KEY");
  if (elevenKey) {
    cfg.elevenlabs = {
      apiKey: elevenKey,
      baseUrl: val(env, "ELEVENLABS_BASE_URL") ?? "https://api.elevenlabs.io",
      modelId: val(env, "ACF_TTS_MODEL") ?? "eleven_multilingual_v2",
    };
  }

  // --- video ---
  const submitUrl = val(env, "ACF_VIDEO_SUBMIT_URL");
  const statusUrlTemplate = val(env, "ACF_VIDEO_STATUS_URL");
  if (submitUrl && statusUrlTemplate) {
    const apiKey = val(env, "ACF_VIDEO_API_KEY");
    cfg.video = {
      submitUrl,
      statusUrlTemplate,
      model: val(env, "ACF_VIDEO_MODEL") ?? "ltx-video",
      ...(apiKey ? { apiKey } : {}),
      pollIntervalMs: Number(val(env, "ACF_VIDEO_POLL_MS") ?? "5000"),
      maxPollMs: Number(val(env, "ACF_VIDEO_MAX_POLL_MS") ?? "600000"),
      // An API key on the render queue is just auth on our own infrastructure — a
      // commercial endpoint must be opted into explicitly.
      mode: val(env, "ACF_VIDEO_MODE") === "commercial" ? "commercial" : "self-hosted",
    };
  }

  return cfg;
}
