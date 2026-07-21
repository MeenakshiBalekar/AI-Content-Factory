import type { GeneratedAsset, VideoProvider, VideoRequest } from "./provider.ts";
import { HttpClient, ProviderError } from "./http/http-client.ts";
import type { AsyncVideoConfig } from "./http/config.ts";

interface SubmitResponse {
  readonly id: string;
}
interface StatusResponse {
  readonly status: "queued" | "processing" | "succeeded" | "failed";
  readonly url?: string;
  readonly error?: string;
}

/**
 * VideoProvider for the async "handle" flow: POST a job, get an id, poll a status endpoint
 * until the render is ready. This is the protocol of OUR OWN render queue — a thin service
 * in front of ComfyUI workers running open-weights video models (LTX-Video, Wan 2.1,
 * HunyuanVideo, CogVideoX) on our GPUs. Minutes-long renders don't block: the orchestrator
 * awaits one call and the polling is internal. The API key is optional (auth on our own
 * queue, if any). Commercial endpoints that use the same submit/poll shape also fit through
 * this adapter, but nothing depends on them.
 */
export class AsyncVideoProvider implements VideoProvider {
  readonly name = "async-video";
  readonly #http: HttpClient;
  readonly #cfg: AsyncVideoConfig;
  readonly #now: () => number;

  constructor(cfg: AsyncVideoConfig, http?: HttpClient, now: () => number = Date.now) {
    this.#cfg = cfg;
    this.#http = http ?? new HttpClient({ provider: this.name, defaultTimeoutMs: 60_000 });
    this.#now = now;
  }

  async generateVideo(req: VideoRequest): Promise<GeneratedAsset> {
    const submit = await this.#http.requestJson<SubmitResponse>({
      method: "POST",
      url: this.#cfg.submitUrl,
      ...(this.#cfg.apiKey ? { headers: { authorization: `Bearer ${this.#cfg.apiKey}` } } : {}),
      body: {
        model: this.#cfg.model,
        prompt: req.prompt,
        seed: req.seed,
        aspect_ratio: req.aspect,
        duration: req.durationSec,
        ...(req.imageUri ? { image_url: req.imageUri } : {}),
      },
    });

    if (!submit.id) throw new Error(`${this.name}: submit returned no job id`);
    return this.#poll(submit.id, req.seed);
  }

  async #poll(id: string, seed: number): Promise<GeneratedAsset> {
    const deadline = this.#now() + this.#cfg.maxPollMs;
    const statusUrl = this.#cfg.statusUrlTemplate.replace("{id}", encodeURIComponent(id));

    for (;;) {
      const status = await this.#http.requestJson<StatusResponse>({
        method: "GET",
        url: statusUrl,
        ...(this.#cfg.apiKey ? { headers: { authorization: `Bearer ${this.#cfg.apiKey}` } } : {}),
      });

      if (status.status === "succeeded") {
        if (!status.url) throw new Error(`${this.name}: job ${id} succeeded without a url`);
        return { outputUri: status.url, provider: this.name, meta: { jobId: id, seed } };
      }
      if (status.status === "failed") {
        throw new ProviderError({
          message: `${this.name}: job ${id} failed: ${status.error ?? "unknown"}`,
          provider: this.name,
          retryable: false,
        });
      }
      if (this.#now() >= deadline) {
        throw new ProviderError({
          message: `${this.name}: job ${id} did not finish within ${this.#cfg.maxPollMs}ms`,
          provider: this.name,
          retryable: false,
        });
      }
      await new Promise((r) => setTimeout(r, this.#cfg.pollIntervalMs));
    }
  }
}
