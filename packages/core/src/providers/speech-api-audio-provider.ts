import { createHash } from "node:crypto";
import type { AudioProvider, AudioRequest, GeneratedAsset } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { SpeechConfig } from "./http/config.ts";
import type { ObjectStore } from "../storage/object-store.ts";

/**
 * AudioProvider speaking the speech protocol (`/v1/audio/speech`) — served self-hosted by
 * Kokoro-FastAPI (Kokoro-82M), Speaches (Piper/Kokoro), and LocalAI (Coqui XTTS-v2 voice
 * cloning) on your own GPUs. The locked VoiceProfile.providerVoiceRef maps to the server's
 * voice name, so a character always speaks with the same voice. No API key required.
 */
export class SpeechApiAudioProvider implements AudioProvider {
  readonly name = "speech-api";
  readonly #http: HttpClient;
  readonly #cfg: SpeechConfig;
  readonly #store: ObjectStore;

  constructor(cfg: SpeechConfig, store: ObjectStore, http?: HttpClient) {
    this.#cfg = cfg;
    this.#store = store;
    this.#http = http ?? new HttpClient({ provider: this.name, defaultTimeoutMs: 120_000 });
  }

  async generateAudio(req: AudioRequest): Promise<GeneratedAsset> {
    const bytes = await this.#http.requestBytes({
      method: "POST",
      url: `${this.#cfg.baseUrl}/v1/audio/speech`,
      headers: {
        accept: "audio/mpeg",
        ...(this.#cfg.apiKey ? { authorization: `Bearer ${this.#cfg.apiKey}` } : {}),
      },
      expect: "bytes",
      timeoutMs: 120_000,
      body: {
        model: this.#cfg.model,
        input: req.text,
        voice: req.voiceRef,
        speed: Math.min(2, Math.max(0.5, req.speed)),
        response_format: "mp3",
      },
    });

    const key = createHash("sha256")
      .update(`${req.voiceRef}|${req.text}|${req.emotion}|${req.speed}`)
      .digest("hex")
      .slice(0, 16);
    const uri = await this.#store.put(`audio/${key}.mp3`, bytes, "audio/mpeg");
    return {
      outputUri: uri,
      provider: this.name,
      meta: { voice: req.voiceRef, emotion: req.emotion, bytes: bytes.length },
    };
  }
}
