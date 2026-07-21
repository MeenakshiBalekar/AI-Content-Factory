import type { ChannelId } from "../domain/ids.ts";
import {
  UnknownChannelError,
  type MemoryStore,
} from "../memory/memory-store.ts";
import { nextPublishAt } from "./scheduler.ts";
import type { PublishRecord, PublishTarget } from "./publish-target.ts";

/**
 * Publishing service (Module 6): resolves an episode from memory, sends it to a PublishTarget,
 * records the publication back into channel memory, and can report the next scheduled slot
 * from the channel's cadence. Depends only on the MemoryStore + PublishTarget interfaces.
 */
export class PublishingService {
  readonly #store: MemoryStore;
  readonly #target: PublishTarget;

  constructor(store: MemoryStore, target: PublishTarget) {
    this.#store = store;
    this.#target = target;
  }

  async publish(channelId: ChannelId, episodeNumber: number): Promise<PublishRecord> {
    const memory = await this.#store.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);
    const episode = memory.episodes.find((e) => e.number === episodeNumber);
    if (!episode) throw new Error(`channel "${channelId}" has no episode ${episodeNumber}`);

    const record = await this.#target.publish(episode, memory);

    const publications = { ...(memory.publications ?? {}) };
    publications[episodeNumber] = [...(publications[episodeNumber] ?? []), record];
    await this.#store.save({ ...memory, publications });
    return record;
  }

  /** Next publish time for the channel's cadence, strictly after `from` (default: now). */
  async nextSlot(channelId: ChannelId, from: Date = new Date()): Promise<Date> {
    const memory = await this.#store.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);
    return nextPublishAt(memory.channel.schedule.cadence, from);
  }
}
