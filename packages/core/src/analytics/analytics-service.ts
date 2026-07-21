import type { ChannelId } from "../domain/ids.ts";
import {
  UnknownChannelError,
  type ChannelMemory,
  type MemoryStore,
} from "../memory/memory-store.ts";
import { mergeMetrics, validateMetrics, type EpisodeMetrics } from "./metrics.ts";
import { applyLearnings, computeInsights, type ChannelInsights } from "./insights.ts";

/**
 * Orchestrates the learning loop against the store: ingest metrics → recompute insights →
 * write learnings back into channel memory. Depends only on the MemoryStore interface, so it
 * works identically over JSON or SQLite persistence.
 */
export class AnalyticsService {
  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  async #load(channelId: ChannelId): Promise<ChannelMemory> {
    const memory = await this.#store.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);
    return memory;
  }

  /** Merge metrics into memory, recompute insights, apply learnings, persist. Returns both. */
  async ingest(
    channelId: ChannelId,
    rows: readonly EpisodeMetrics[],
  ): Promise<{ insights: ChannelInsights; applied: boolean }> {
    const problems = validateMetrics(rows);
    if (problems.length) throw new Error(`invalid metrics: ${problems.join("; ")}`);

    const memory = await this.#load(channelId);
    const metrics = mergeMetrics(memory.metrics ?? [], rows);
    const insights = computeInsights(memory.episodes, metrics);
    const learned = applyLearnings({ ...memory, metrics }, insights);

    await this.#store.save(learned);
    return { insights, applied: insights.sampled > 0 };
  }

  /** Recompute insights from already-stored metrics without ingesting new rows. */
  async insights(channelId: ChannelId): Promise<ChannelInsights> {
    const memory = await this.#load(channelId);
    return computeInsights(memory.episodes, memory.metrics ?? []);
  }
}
