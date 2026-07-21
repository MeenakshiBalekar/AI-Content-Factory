import type { ChannelId, CharacterId, EnvironmentId, EpisodeId } from "./ids.ts";
import type { QualityReport } from "../quality/report.ts";

/** The kinds of assets the pipeline produces. Kept as a string-literal union (no enum)
 *  so the code stays within erasable TypeScript. */
export type AssetKind =
  | "story"
  | "script"
  | "storyboard"
  | "image"
  | "voice"
  | "music"
  | "video"
  | "subtitles"
  | "thumbnail"
  | "metadata";

export type StepStatus = "planned" | "generating" | "succeeded" | "failed";

/** One produced (or planned) asset, with the exact prompt used — full auditability. */
export interface EpisodeAsset {
  readonly kind: AssetKind;
  readonly label: string;
  readonly prompt: string;
  readonly provider: string;
  readonly status: StepStatus;
  readonly outputUri?: string;
  readonly meta?: Readonly<Record<string, string | number>>;
  readonly error?: string;
}

/** A single beat of the story, tying a character and location to the memory. */
export interface StoryBeat {
  readonly index: number;
  readonly summary: string;
  readonly characterIds: readonly CharacterId[];
  readonly environmentId: EnvironmentId;
  readonly dialogue: readonly { readonly characterId: CharacterId; readonly line: string }[];
}

export interface Episode {
  readonly id: EpisodeId;
  readonly channelId: ChannelId;
  readonly number: number; // "Episode 248"
  readonly title: string;
  readonly logline: string;
  readonly beats: readonly StoryBeat[];
  readonly assets: readonly EpisodeAsset[];
  /** Quality audit, attached when the orchestrator runs with a QualityEngine (Module 4). */
  readonly quality?: QualityReport;
  /** Which workflow produced this episode (Module 5); "standard" when unset by the caller. */
  readonly workflowId?: string;
  readonly createdAt: string;
}

/** Compact recap used as memory context when planning the *next* episode. */
export function recapOf(ep: Episode): string {
  return `Ep ${ep.number} "${ep.title}": ${ep.logline}`;
}
