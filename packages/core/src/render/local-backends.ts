import { ImagesApiImageProvider } from "../providers/images-api-image-provider.ts";
import { Automatic1111ImageProvider } from "../providers/automatic1111-image-provider.ts";
import { SpeechApiAudioProvider } from "../providers/speech-api-audio-provider.ts";
import { ProviderError } from "../providers/http/http-client.ts";
import type { ImageProvider } from "../providers/provider.ts";
import { FileObjectStore } from "../storage/object-store.ts";
import { fileURLToPath } from "node:url";

/** Which image API a self-hosted server speaks. "openai" = /v1/images/generations (LocalAI,
 *  SD-WebUI openai ext); "automatic1111" = /sdapi/v1/txt2img (Draw Things, A1111, SD.Next). */
export type ImageApi = "openai" | "automatic1111";

export interface LocalImageOptions {
  readonly api?: ImageApi;
  readonly steps?: number;
  readonly negativePrompt?: string;
  readonly maxEdge?: number;
}

/**
 * Named local backends for the render pipeline. These are REAL HTTP adapters to self-hosted
 * inference servers. If the configured backend is unreachable they fail honestly with a clear
 * error — they never fall back to a placeholder silently. (The render service decides, per
 * explicit configuration, whether procedural placeholders are acceptable; these classes do
 * not.) No commercial API is involved.
 */

export class LocalBackendUnavailableError extends Error {
  constructor(kind: string, baseUrl: string, cause: unknown) {
    super(
      `Local ${kind} backend at ${baseUrl} is unavailable. Start the server or unset its ` +
        `base URL to use procedural placeholders. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "LocalBackendUnavailableError";
  }
}

/** LocalImageProvider — image generation via a self-hosted server. Supports two protocols:
 *  the OpenAI images API (LocalAI, SD-WebUI openai ext) and the AUTOMATIC1111 txt2img API
 *  (Draw Things on Apple Silicon, A1111, SD.Next). Selected by `opts.api`. */
export class LocalImageProvider {
  readonly baseUrl: string;
  readonly api: ImageApi;
  readonly #inner: ImageProvider;

  constructor(baseUrl: string, model: string, assetRoot: string, opts: LocalImageOptions = {}) {
    this.baseUrl = baseUrl;
    this.api = opts.api ?? "openai";
    const store = new FileObjectStore(assetRoot);
    this.#inner =
      this.api === "automatic1111"
        ? new Automatic1111ImageProvider(
            {
              baseUrl,
              steps: opts.steps ?? 24,
              cfgScale: 7,
              negativePrompt: opts.negativePrompt ?? "blurry, low quality, deformed, extra limbs, text, watermark",
              maxEdge: opts.maxEdge ?? 768,
              // No checkpoint override: Draw Things (and the API user) select the model in
              // the app; sending a bogus name would make it try to switch checkpoints.
            },
            store,
          )
        : new ImagesApiImageProvider({ baseUrl, model, mode: "self-hosted" }, store);
  }

  /** Generate one image to disk; returns the absolute file path. Honest failure on outage. */
  async generateToFile(prompt: string, seed: number, aspect: string): Promise<string> {
    try {
      const asset = await this.#inner.generateImage({ prompt, seed, aspect });
      return fileURLToPath(asset.outputUri);
    } catch (err) {
      if (err instanceof ProviderError) throw new LocalBackendUnavailableError("image", this.baseUrl, err);
      throw err;
    }
  }
}

/** LocalSpeechProvider — text-to-speech via a self-hosted /v1/audio/speech server
 *  (Kokoro-FastAPI, Speaches, LocalAI XTTS). */
export class LocalSpeechProvider {
  readonly baseUrl: string;
  readonly #inner: SpeechApiAudioProvider;

  constructor(baseUrl: string, model: string, assetRoot: string) {
    this.baseUrl = baseUrl;
    this.#inner = new SpeechApiAudioProvider(
      { baseUrl, model, mode: "self-hosted" },
      new FileObjectStore(assetRoot),
    );
  }

  /** Synthesize one line to disk; returns the absolute file path. Honest failure on outage. */
  async generateToFile(text: string, voiceRef: string, speed: number, emotion: string): Promise<string> {
    try {
      const asset = await this.#inner.generateAudio({ text, voiceRef, pitch: 0, speed, emotion });
      return fileURLToPath(asset.outputUri);
    } catch (err) {
      if (err instanceof ProviderError) throw new LocalBackendUnavailableError("speech", this.baseUrl, err);
      throw err;
    }
  }
}

/** Read image/speech base URLs from the environment. ACF_AUDIO_BASE_URL is the render-mode
 *  name; ACF_SPEECH_BASE_URL (from Module 2 config) is accepted as an alias. */
export function localBackendConfig(env: Record<string, string | undefined> = process.env): {
  imageBaseUrl?: string;
  imageModel: string;
  imageApi: ImageApi;
  imageSteps?: number;
  imageMaxEdge?: number;
  imageNegative?: string;
  audioBaseUrl?: string;
  audioModel: string;
  musicFile?: string;
} {
  const pick = (k: string): string | undefined => {
    const v = env[k];
    return v && v.trim() ? v.trim() : undefined;
  };
  // ACF_IMAGE_API selects the protocol. Accept friendly aliases for the A1111 family.
  const apiRaw = (pick("ACF_IMAGE_API") ?? "openai").toLowerCase();
  const imageApi: ImageApi =
    apiRaw === "automatic1111" || apiRaw === "a1111" || apiRaw === "drawthings" || apiRaw === "sdapi"
      ? "automatic1111"
      : "openai";
  const steps = pick("ACF_IMAGE_STEPS");
  const maxEdge = pick("ACF_IMAGE_MAX_EDGE");
  return {
    ...(pick("ACF_IMAGE_BASE_URL") ? { imageBaseUrl: pick("ACF_IMAGE_BASE_URL")! } : {}),
    imageModel: pick("ACF_IMAGE_MODEL") ?? "flux.1-schnell",
    imageApi,
    ...(steps && Number.isFinite(Number(steps)) ? { imageSteps: Number(steps) } : {}),
    ...(maxEdge && Number.isFinite(Number(maxEdge)) ? { imageMaxEdge: Number(maxEdge) } : {}),
    ...(pick("ACF_IMAGE_NEGATIVE") ? { imageNegative: pick("ACF_IMAGE_NEGATIVE")! } : {}),
    ...(pick("ACF_AUDIO_BASE_URL") ?? pick("ACF_SPEECH_BASE_URL")
      ? { audioBaseUrl: (pick("ACF_AUDIO_BASE_URL") ?? pick("ACF_SPEECH_BASE_URL"))! }
      : {}),
    audioModel: pick("ACF_SPEECH_MODEL") ?? "kokoro",
    ...(pick("ACF_MUSIC_FILE") ? { musicFile: pick("ACF_MUSIC_FILE")! } : {}),
  };
}
