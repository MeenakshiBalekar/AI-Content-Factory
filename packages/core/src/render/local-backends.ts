import { ImagesApiImageProvider } from "../providers/images-api-image-provider.ts";
import { SpeechApiAudioProvider } from "../providers/speech-api-audio-provider.ts";
import { HttpClient, ProviderError } from "../providers/http/http-client.ts";
import { FileObjectStore } from "../storage/object-store.ts";
import { fileURLToPath } from "node:url";

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

/** LocalImageProvider — image generation via a self-hosted OpenAI-images-compatible server
 *  (LocalAI, SD-WebUI openai extension, or a ComfyUI bridge exposing /v1/images/generations). */
export class LocalImageProvider {
  readonly baseUrl: string;
  readonly #inner: ImagesApiImageProvider;

  constructor(baseUrl: string, model: string, assetRoot: string) {
    this.baseUrl = baseUrl;
    this.#inner = new ImagesApiImageProvider(
      { baseUrl, model, mode: "self-hosted" },
      new FileObjectStore(assetRoot),
    );
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
  audioBaseUrl?: string;
  audioModel: string;
  musicFile?: string;
} {
  const pick = (k: string): string | undefined => {
    const v = env[k];
    return v && v.trim() ? v.trim() : undefined;
  };
  return {
    ...(pick("ACF_IMAGE_BASE_URL") ? { imageBaseUrl: pick("ACF_IMAGE_BASE_URL")! } : {}),
    imageModel: pick("ACF_IMAGE_MODEL") ?? "flux.1-schnell",
    ...(pick("ACF_AUDIO_BASE_URL") ?? pick("ACF_SPEECH_BASE_URL")
      ? { audioBaseUrl: (pick("ACF_AUDIO_BASE_URL") ?? pick("ACF_SPEECH_BASE_URL"))! }
      : {}),
    audioModel: pick("ACF_SPEECH_MODEL") ?? "kokoro",
    ...(pick("ACF_MUSIC_FILE") ? { musicFile: pick("ACF_MUSIC_FILE")! } : {}),
  };
}
