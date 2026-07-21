import type { GeneratedAsset, ImageProvider, ImageRequest } from "./provider.ts";
import { HttpClient } from "./http/http-client.ts";
import type { OpenAIImageConfig } from "./http/config.ts";
import type { ObjectStore } from "../storage/object-store.ts";

interface ImageGenResponse {
  readonly data: readonly { readonly b64_json?: string; readonly url?: string }[];
}

/** Maps our aspect ratios to the fixed sizes the images API accepts. */
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
 * ImageProvider backed by the OpenAI Images API. Returned base64 bytes are written to the
 * ObjectStore under a content-addressed key derived from the seed, so the recorded URI is
 * durable and re-runs with the same seed overwrite the same object (idempotent).
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai-image";
  readonly #http: HttpClient;
  readonly #cfg: OpenAIImageConfig;
  readonly #store: ObjectStore;

  constructor(cfg: OpenAIImageConfig, store: ObjectStore, http?: HttpClient) {
    this.#cfg = cfg;
    this.#store = store;
    this.#http = http ?? new HttpClient({ provider: this.name, defaultTimeoutMs: 120_000 });
  }

  async generateImage(req: ImageRequest): Promise<GeneratedAsset> {
    const res = await this.#http.requestJson<ImageGenResponse>({
      method: "POST",
      url: `${this.#cfg.baseUrl}/v1/images/generations`,
      headers: { authorization: `Bearer ${this.#cfg.apiKey}` },
      timeoutMs: 120_000,
      body: {
        model: this.#cfg.model,
        prompt: req.prompt,
        size: sizeForAspect(req.aspect),
        n: 1,
      },
    });

    const first = res.data[0];
    if (!first?.b64_json) {
      throw new Error(`${this.name}: response had no base64 image`);
    }
    const bytes = Buffer.from(first.b64_json, "base64");
    const uri = await this.#store.put(`image/${req.seed}.png`, bytes, "image/png");
    return { outputUri: uri, provider: this.name, meta: { seed: req.seed, bytes: bytes.length } };
  }
}
