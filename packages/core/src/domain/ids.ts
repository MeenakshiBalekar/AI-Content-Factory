/**
 * Branded identifiers. Branding prevents accidentally passing a ChannelId where
 * a CharacterId is expected — they are all strings at runtime, distinct at compile time.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ChannelId = Brand<string, "ChannelId">;
export type CharacterId = Brand<string, "CharacterId">;
export type VoiceId = Brand<string, "VoiceId">;
export type EnvironmentId = Brand<string, "EnvironmentId">;
export type EpisodeId = Brand<string, "EpisodeId">;

export const asChannelId = (v: string): ChannelId => v as ChannelId;
export const asCharacterId = (v: string): CharacterId => v as CharacterId;
export const asVoiceId = (v: string): VoiceId => v as VoiceId;
export const asEnvironmentId = (v: string): EnvironmentId => v as EnvironmentId;
export const asEpisodeId = (v: string): EpisodeId => v as EpisodeId;

/** A slug-safe id derived from a human label, e.g. "Milo the Fox" -> "milo-the-fox". */
export const slugify = (label: string): string =>
  label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "untitled";
