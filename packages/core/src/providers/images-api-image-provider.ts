import type { GeneratedAsset, ImageProvider, ImageRequest } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { ImageGenConfig } from "./http/config.ts";
import type { ObjectStore } from "../storage/object-store.ts";

interface ImageGenResponse {
  readonly data: readonly { readonly b64_json?: string; readonly url?: string }[];
}

/** Maps our aspect ratios to the fixed sizes the images endpoint accepts. */
function sizeForAspect(aspect: string): string {
  switch (aspect) {
    case "9:16":
    case "3:4":
      return "1024x1536";
    case "16:9":
    case "4:3":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

/**
 * ImageProvider speaking the Images-generation protocol (`/v1/images/generations`) — served
 * self-hosted by LocalAI and SD-WebUI-compatible bridges running open-weights diffusion
 * models (FLUX.1 schnell/dev, SDXL, SD 3.5). Point `baseUrl` at your own GPU server; no API
 * key required. Returned base64 bytes are written to the ObjectStore under a
 * content-addressed key derived from the seed, so re-runs are idempotent.
 */
export class ImagesApiImageProvider implements ImageProvider {
  readonly name = "images-api";
  readonly #http: HttpClient;
  readonly #cfg: ImageGenConfig;
  readonly #store: ObjectStore;

  constructor(cfg: ImageGenConfig, store: ObjectStore, http?: HttpClient) {
    this.#cfg = cfg;
    this.#store = store;
    this.#http = http ?? new HttpClient({ provider: this.name, defaultTimeoutMs: 120_000 });
  }

  async generateImage(req: ImageRequest): Promise<GeneratedAsset> {
    const res = await this.#http.requestJson<ImageGenResponse>({
      method: "POST",
      url: `${this.#cfg.baseUrl}/v1/images/generations`,
      ...(this.#cfg.apiKey ? { headers: { authorization: `Bearer ${this.#cfg.apiKey}` } } : {}),
      timeoutMs: 120_000,
      body: {
        model: this.#cfg.model,
        prompt: req.prompt,
        size: sizeForAspect(req.aspect),
        n: 1,
        // Ask for base64 inline; servers that ignore this and return a URL are handled below.
        response_format: "b64_json",
      },
    });

    const first = res.data[0];
    if (!first) throw new Error(`${this.name}: response contained no image`);

    // Prefer inline base64; otherwise download the returned URL (LocalAI / SD-WebUI often
    // return a hosted URL). Either way we persist real bytes to the object store.
    let bytes: Uint8Array;
    if (first.b64_json) {
      bytes = Buffer.from(first.b64_json, "base64");
    } else if (first.url) {
      bytes = await this.#http.requestBytes({ method: "GET", url: first.url, expect: "bytes", timeoutMs: 120_000 });
    } else {
      throw new Error(`${this.name}: response had neither b64_json nor url`);
    }

    const uri = await this.#store.put(`image/${req.seed}.png`, bytes, "image/png");
    return { outputUri: uri, provider: this.name, meta: { seed: req.seed, bytes: bytes.length } };
  }
}
