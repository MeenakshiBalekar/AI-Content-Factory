import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GeneratedAsset, VideoProvider, VideoRequest } from "./provider.ts";
import { HttpClient, ProviderError } from "./http/http-client.ts";

/**
 * VideoProvider backed by Replicate's predictions API — the cloud image→video engine for the
 * AI Video Director Agent. It takes a per-shot keyframe (generated locally for character
 * consistency) plus a motion prompt (the shot's action) and returns a short animated clip.
 * This is the "real motion" step that cannot run on a small local machine; Replicate hosts
 * open + commercial video models (Kling, Wan, LTX, Luma, …) behind one submit→poll API.
 *
 * This is a paid cloud call. Nothing selects it unless REPLICATE_API_TOKEN + a model are
 * configured; the render pipeline otherwise stays fully local.
 */

export interface ReplicateVideoConfig {
  readonly token: string;
  /** "owner/name" (official model) or a 64-hex version id. */
  readonly model: string;
  readonly baseUrl: string; // default https://api.replicate.com
  /** Input field the chosen model expects the start image under (kling: "start_image",
   *  many: "image"). */
  readonly imageField: string;
  /** Extra static input fields to pass through to the model (e.g. { cfg_scale: 0.5 }). */
  readonly extraInput: Readonly<Record<string, unknown>>;
  readonly pollIntervalMs: number;
  readonly maxPollMs: number;
}

interface Prediction {
  readonly id?: string;
  readonly status?: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  readonly urls?: { readonly get?: string };
  readonly output?: unknown;
  readonly error?: unknown;
}

function isVersionId(model: string): boolean {
  return /^[0-9a-f]{64}$/i.test(model) || (!model.includes("/") && model.length >= 32);
}

async function toDataUri(imageUri: string): Promise<string> {
  const path = imageUri.startsWith("file://") ? fileURLToPath(imageUri) : imageUri;
  const bytes = await readFile(path);
  const ext = path.toLowerCase().endsWith(".jpg") || path.toLowerCase().endsWith(".jpeg") ? "jpeg" : "png";
  return `data:image/${ext};base64,${bytes.toString("base64")}`;
}

/** Replicate returns output as a URL string or an array of URL strings. */
function firstUrl(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const s = output.find((x) => typeof x === "string");
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

export class ReplicateVideoProvider implements VideoProvider {
  readonly name = "replicate-video";
  readonly #http: HttpClient;
  readonly #cfg: ReplicateVideoConfig;
  readonly #now: () => number;

  constructor(cfg: ReplicateVideoConfig, http?: HttpClient, now: () => number = Date.now) {
    this.#cfg = cfg;
    this.#http = http ?? new HttpClient({
      provider: this.name,
      defaultTimeoutMs: 120_000,
      retry: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 2000 },
    });
    this.#now = now;
  }

  #headers(): Record<string, string> {
    return { authorization: `Token ${this.#cfg.token}`, "content-type": "application/json" };
  }

  async generateVideo(req: VideoRequest): Promise<GeneratedAsset> {
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      ...this.#cfg.extraInput,
    };
    if (req.imageUri) input[this.#cfg.imageField] = await toDataUri(req.imageUri);

    const submitUrl = isVersionId(this.#cfg.model)
      ? `${this.#cfg.baseUrl}/v1/predictions`
      : `${this.#cfg.baseUrl}/v1/models/${this.#cfg.model}/predictions`;
    const body = isVersionId(this.#cfg.model) ? { version: this.#cfg.model, input } : { input };

    const submit = await this.#http.requestJson<Prediction>({
      method: "POST",
      url: submitUrl,
      headers: this.#headers(),
      body,
      timeoutMs: 120_000,
    });

    // Some models finish synchronously; otherwise poll the status URL.
    const done = submit.status === "succeeded" ? submit : await this.#poll(submit);
    const url = firstUrl(done.output);
    if (!url) throw new Error(`${this.name}: prediction succeeded but had no video URL`);
    return { outputUri: url, provider: this.name, meta: { seed: req.seed, model: this.#cfg.model } };
  }

  async #poll(initial: Prediction): Promise<Prediction> {
    const getUrl = initial.urls?.get;
    if (!getUrl) throw new Error(`${this.name}: no poll URL in prediction response`);
    const deadline = this.#now() + this.#cfg.maxPollMs;
    for (;;) {
      const p = await this.#http.requestJson<Prediction>({
        method: "GET",
        url: getUrl,
        headers: this.#headers(),
      });
      if (p.status === "succeeded") return p;
      if (p.status === "failed" || p.status === "canceled") {
        throw new ProviderError({
          message: `${this.name}: prediction ${p.status}: ${String(p.error ?? "unknown")}`,
          provider: this.name,
          retryable: false,
        });
      }
      if (this.#now() >= deadline) {
        throw new ProviderError({
          message: `${this.name}: prediction did not finish within ${this.#cfg.maxPollMs}ms`,
          provider: this.name,
          retryable: false,
        });
      }
      await new Promise((r) => setTimeout(r, this.#cfg.pollIntervalMs));
    }
  }
}
