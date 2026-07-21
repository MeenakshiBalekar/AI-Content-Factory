/**
 * A small, dependency-free HTTP client shared by every real provider adapter. It exists so
 * adapters don't each re-implement timeouts, retries, auth, and error mapping — the concerns
 * that actually make external model calls reliable in production.
 *
 * - Per-request timeout via AbortSignal (a hung provider must not hang the pipeline).
 * - Exponential backoff with jitter on transient failures (network errors, 429, 5xx).
 * - Typed ProviderError so the orchestrator/quality engine can react to failures.
 */

export interface RetryPolicy {
  readonly maxAttempts: number; // total attempts including the first
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

/** A structured provider failure. `retryable` tells callers whether a retry could help. */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly provider: string;

  constructor(args: {
    message: string;
    provider: string;
    status?: number;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "ProviderError";
    this.provider = args.provider;
    this.status = args.status;
    this.retryable = args.retryable;
  }
}

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown; // JSON-serialized unless it is a string/Buffer
  readonly timeoutMs?: number;
  /** Expected response kind. "json" parses; "bytes" returns raw Uint8Array (audio/image). */
  readonly expect?: "json" | "bytes";
}

export interface HttpClientOptions {
  readonly provider: string;
  readonly retry?: RetryPolicy;
  readonly defaultTimeoutMs?: number;
  /** Injectable fetch — real `globalThis.fetch` in prod, a stub in tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable sleep so tests don't actually wait out backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export class HttpClient {
  readonly #provider: string;
  readonly #retry: RetryPolicy;
  readonly #defaultTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpClientOptions) {
    this.#provider = opts.provider;
    this.#retry = opts.retry ?? DEFAULT_RETRY;
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#sleep = opts.sleep ?? realSleep;
  }

  #backoff(attempt: number): number {
    const exp = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** attempt);
    return Math.floor(exp / 2 + Math.random() * (exp / 2)); // full-ish jitter
  }

  async requestJson<T>(req: HttpRequest): Promise<T> {
    return (await this.#send(req, "json")) as T;
  }

  async requestBytes(req: HttpRequest): Promise<Uint8Array> {
    return (await this.#send(req, "bytes")) as Uint8Array;
  }

  async #send(req: HttpRequest, expect: "json" | "bytes"): Promise<unknown> {
    let lastErr: ProviderError | undefined;
    for (let attempt = 0; attempt < this.#retry.maxAttempts; attempt++) {
      try {
        return await this.#once(req, expect);
      } catch (err) {
        const pErr =
          err instanceof ProviderError
            ? err
            : new ProviderError({
                message: err instanceof Error ? err.message : String(err),
                provider: this.#provider,
                retryable: true, // network-level failures are worth retrying
                cause: err,
              });
        lastErr = pErr;
        const isLast = attempt === this.#retry.maxAttempts - 1;
        if (!pErr.retryable || isLast) throw pErr;
        await this.#sleep(this.#backoff(attempt));
      }
    }
    // Unreachable — the loop either returns or throws — but satisfies the type checker.
    throw lastErr ?? new ProviderError({ message: "request failed", provider: this.#provider, retryable: false });
  }

  async #once(req: HttpRequest, expect: "json" | "bytes"): Promise<unknown> {
    const timeoutMs = req.timeoutMs ?? this.#defaultTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === "string") {
        body = req.body;
      } else {
        body = JSON.stringify(req.body);
        headers["content-type"] ??= "application/json";
      }
    }

    let res: Response;
    try {
      res = await this.#fetch(req.url, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "TimeoutError";
      throw new ProviderError({
        message: aborted ? `request timed out after ${timeoutMs}ms` : `network error: ${String(err)}`,
        provider: this.#provider,
        retryable: true,
        cause: err,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError({
        message: `HTTP ${res.status} from ${this.#provider}: ${text.slice(0, 300)}`,
        provider: this.#provider,
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }

    if (expect === "bytes") {
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }
    return (await res.json()) as unknown;
  }
}
