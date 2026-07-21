import { randomUUID } from "node:crypto";

/**
 * Async job abstraction. `episode.create` can take minutes (real video renders), so the API
 * must return immediately with a job id and let the caller poll or stream progress. This is
 * the seam BullMQ/Redis implements in production; `InMemoryJobQueue` implements it for a
 * single process so the whole stack runs and is testable without a broker.
 */

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface JobEvent {
  readonly at: string;
  readonly label: string;
  readonly data?: Readonly<Record<string, string | number>>;
}

export interface Job<T> {
  readonly id: string;
  readonly state: JobState;
  readonly events: readonly JobEvent[];
  readonly result?: T;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The unit of work. `emit` publishes progress events as the task runs. */
export type JobTask<T> = (emit: (e: JobEvent) => void) => Promise<T>;

export interface JobQueue<T> {
  /** Enqueue a task; returns its id. The task begins running asynchronously. */
  submit(task: JobTask<T>): string;
  get(id: string): Job<T> | undefined;
  /** Resolves when the job leaves a non-terminal state — convenience for callers/tests. */
  wait(id: string, timeoutMs?: number): Promise<Job<T>>;
}

interface MutableJob<T> {
  id: string;
  state: JobState;
  events: JobEvent[];
  result?: T;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class InMemoryJobQueue<T> implements JobQueue<T> {
  readonly #jobs = new Map<string, MutableJob<T>>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  submit(task: JobTask<T>): string {
    const id = randomUUID();
    const ts = this.#now().toISOString();
    const job: MutableJob<T> = { id, state: "queued", events: [], createdAt: ts, updatedAt: ts };
    this.#jobs.set(id, job);

    // Run asynchronously; a broker-backed queue would hand this to a worker instead.
    void (async () => {
      job.state = "running";
      job.updatedAt = this.#now().toISOString();
      try {
        const result = await task((e) => {
          job.events.push(e);
          job.updatedAt = this.#now().toISOString();
        });
        job.result = result;
        job.state = "succeeded";
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        job.state = "failed";
      }
      job.updatedAt = this.#now().toISOString();
    })();

    return id;
  }

  get(id: string): Job<T> | undefined {
    const j = this.#jobs.get(id);
    if (!j) return undefined;
    return this.#snapshot(j);
  }

  async wait(id: string, timeoutMs = 30_000): Promise<Job<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const j = this.#jobs.get(id);
      if (!j) throw new Error(`Unknown job "${id}"`);
      if (j.state === "succeeded" || j.state === "failed") return this.#snapshot(j);
      if (Date.now() >= deadline) throw new Error(`Job "${id}" did not settle within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  #snapshot(j: MutableJob<T>): Job<T> {
    return {
      id: j.id,
      state: j.state,
      events: [...j.events],
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      ...(j.result !== undefined ? { result: j.result } : {}),
      ...(j.error !== undefined ? { error: j.error } : {}),
    };
  }
}
