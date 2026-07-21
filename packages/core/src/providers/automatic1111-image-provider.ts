import type { GeneratedAsset, ImageProvider, ImageRequest } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { ObjectStore } from "../storage/object-store.ts";

/**
 * ImageProvider speaking the AUTOMATIC1111 `/sdapi/v1/txt2img` protocol — the API implemented
 * by Draw Things' HTTP API server (as well as A1111, SD.Next, and Forge). This is the
 * Apple-Silicon-friendly path: Draw Things runs Stable Diffusion on Metal and exposes this
 * endpoint locally. The orchestrator's detailed character prompt (Milo/Bea consistency) is
 * sent verbatim; the returned base64 PNG is written to the object store as real bytes.
 *
 * Sizes are mapped to Stable-Diffusion-friendly dimensions (multiples of 64, ~512–768) so
 * generation is fast and memory-safe on an 8 GB machine — unlike the 1024²+ the OpenAI-images
 * path requests.
 */

export interface Automatic1111Config {
  readonly baseUrl: string;
  readonly steps: number;
  readonly cfgScale: number;
  readonly negativePrompt: string;
  /** Optional model/checkpoint name; Draw Things ignores it (uses the app's loaded model). */
  readonly model?: string | undefined;
  readonly maxEdge: number; // longest side cap, e.g. 768
}

interface Txt2ImgResponse {
  readonly images?: readonly string[];
}

/** SD-friendly width/height (multiples of 64) for an aspect, capped at `maxEdge`. */
export function sdDimensions(aspect: string, maxEdge: number): { width: number; height: number } {
  const round64 = (n: number): number => Math.max(64, Math.round(n / 64) * 64);
  const base = Math.min(maxEdge, 512);
  switch (aspect) {
    case "16:9":
      return { width: round64(maxEdge), height: round64(maxEdge * (9 / 16)) };
    case "9:16":
      return { width: round64(maxEdge * (9 / 16)), height: round64(maxEdge) };
    case "4:3":
      return { width: round64(base * (4 / 3)), height: round64(base) };
    case "3:4":
      return { width: round64(base), height: round64(base * (4 / 3)) };
    default:
      return { width: base, height: base };
  }
}

export class Automatic1111ImageProvider implements ImageProvider {
  readonly name = "automatic1111";
  readonly #http: HttpClient;
  readonly #cfg: Automatic1111Config;
  readonly #store: ObjectStore;

  constructor(cfg: Automatic1111Config, store: ObjectStore, http?: HttpClient) {
    this.#cfg = cfg;
    this.#store = store;
    // Generation can take tens of seconds on CPU/small-GPU Macs; give it room and don't
    // re-fire the same expensive job on a slow response.
    this.#http = http ?? new HttpClient({
      provider: this.name,
      defaultTimeoutMs: 300_000,
      retry: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 2000 },
    });
  }

  async generateImage(req: ImageRequest): Promise<GeneratedAsset> {
    const { width, height } = sdDimensions(req.aspect, this.#cfg.maxEdge);
    const res = await this.#http.requestJson<Txt2ImgResponse>({
      method: "POST",
      url: `${this.#cfg.baseUrl}/sdapi/v1/txt2img`,
      timeoutMs: 300_000,
      body: {
        prompt: req.prompt,
        negative_prompt: this.#cfg.negativePrompt,
        steps: this.#cfg.steps,
        cfg_scale: this.#cfg.cfgScale,
        width,
        height,
        seed: req.seed,
        batch_size: 1,
        n_iter: 1,
        send_images: true,
        save_images: false,
        ...(this.#cfg.model ? { override_settings: { sd_model_checkpoint: this.#cfg.model } } : {}),
      },
    });

    const first = res.images?.[0];
    if (!first) throw new Error(`${this.name}: txt2img returned no images`);
    // A1111 returns raw base64 PNG; some variants prefix a data URI — strip it defensively.
    const b64 = first.startsWith("data:") ? first.slice(first.indexOf(",") + 1) : first;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) throw new Error(`${this.name}: decoded image was empty`);

    const uri = await this.#store.put(`image/${req.seed}.png`, bytes, "image/png");
    return { outputUri: uri, provider: this.name, meta: { seed: req.seed, bytes: bytes.length, width, height } };
  }
}
