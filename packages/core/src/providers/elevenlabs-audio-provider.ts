import { createHash } from "node:crypto";
import type { AudioProvider, AudioRequest, GeneratedAsset } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { ElevenLabsConfig } from "./http/config.ts";
import type { ObjectStore } from "../storage/object-store.ts";

/**
 * AudioProvider backed by ElevenLabs text-to-speech. The locked VoiceProfile.providerVoiceRef
 * is the ElevenLabs voice id, so a character always uses the same voice. Our pitch/speed/energy
 * map onto ElevenLabs voice settings; emotion is conveyed by the text and stability/style.
 */
export class ElevenLabsAudioProvider implements AudioProvider {
  readonly name = "elevenlabs-audio";
  readonly #http: HttpClient;
  readonly #cfg: ElevenLabsConfig;
  readonly #store: ObjectStore;

  constructor(cfg: ElevenLabsConfig, store: ObjectStore, http?: HttpClient) {
    this.#cfg = cfg;
    this.#store = store;
    this.#http = http ?? new HttpClient({ provider: this.name, defaultTimeoutMs: 120_000 });
  }

  #voiceSettings(req: AudioRequest): {
    stability: number;
    similarity_boost: number;
    style: number;
    speed: number;
  } {
    const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
    // Expressive emotions read better with lower stability + higher style; neutral is steadier.
    const expressive = req.emotion !== "" && req.emotion !== "neutral";
    return {
      stability: expressive ? 0.35 : 0.55,
      similarity_boost: 0.85,
      style: expressive ? 0.45 : 0.2,
      speed: clamp(req.speed, 0.7, 1.2), // ElevenLabs accepts 0.7–1.2
    };
  }

  async generateAudio(req: AudioRequest): Promise<GeneratedAsset> {
    const bytes = await this.#http.requestBytes({
      method: "POST",
      url: `${this.#cfg.baseUrl}/v1/text-to-speech/${encodeURIComponent(req.voiceRef)}`,
      headers: { "xi-api-key": this.#cfg.apiKey, accept: "audio/mpeg" },
      expect: "bytes",
      timeoutMs: 120_000,
      body: {
        text: req.text,
        model_id: this.#cfg.modelId,
        voice_settings: this.#voiceSettings(req),
      },
    });

    const key = createHash("sha256")
      .update(`${req.voiceRef}|${req.text}|${req.emotion}`)
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
