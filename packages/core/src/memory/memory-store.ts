import type { Channel } from "../domain/channel.ts";
import type { Character } from "../domain/character.ts";
import type { Environment } from "../domain/environment.ts";
import type { Episode } from "../domain/episode.ts";
import type { VoiceProfile } from "../domain/voice.ts";
import type {
  ChannelId,
  CharacterId,
  EnvironmentId,
  VoiceId,
} from "../domain/ids.ts";

/** The full persisted memory for a single channel. */
export interface ChannelMemory {
  readonly channel: Channel;
  readonly characters: Readonly<Record<CharacterId, Character>>;
  readonly voices: Readonly<Record<VoiceId, VoiceProfile>>;
  readonly environments: Readonly<Record<EnvironmentId, Environment>>;
  readonly episodes: readonly Episode[];
}

/**
 * The memory contract the orchestrator depends on (Repository pattern / DIP). The
 * orchestrator never touches storage directly, so the JSON store below can be swapped
 * for Postgres/Prisma later with no change to business logic.
 */
export interface MemoryStore {
  listChannels(): Promise<ChannelId[]>;
  load(channelId: ChannelId): Promise<ChannelMemory | undefined>;
  save(memory: ChannelMemory): Promise<void>;
  appendEpisode(channelId: ChannelId, episode: Episode): Promise<void>;
}

/** Thrown when an operation targets a channel that has no memory yet. */
export class UnknownChannelError extends Error {
  constructor(channelId: ChannelId) {
    super(`No memory found for channel "${channelId}"`);
    this.name = "UnknownChannelError";
  }
}
