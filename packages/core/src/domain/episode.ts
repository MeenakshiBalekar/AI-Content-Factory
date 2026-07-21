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
  /** Final rendered MP4 (local render pipeline), present after a successful render. The path
   *  is a real file on disk; sources say whether media was AI-generated or procedural. */
  readonly render?: {
    readonly outputPath: string;
    readonly sizeBytes: number;
    readonly durationSec: number;
    readonly hasVideo: boolean;
    readonly hasAudio: boolean;
    readonly videoCodec: string | undefined;
    readonly audioCodec: string | undefined;
    readonly width: number;
    readonly height: number;
    readonly imageSource: string;
    readonly audioSource: string;
    readonly musicSource: string;
    readonly renderedAt: string;
  };
  /** Multi-agent creative brief (Module 7), attached when the orchestrator runs with a crew.
   *  Structurally typed to keep the domain free of a dependency on the agents module. */
  readonly creativeBrief?: {
    readonly theme: string;
    readonly logline: string;
    readonly hook: string;
    readonly rounds: number;
    readonly approved: boolean;
    readonly transcript: readonly {
      readonly role: string;
      readonly content: string;
      readonly verdict?: "approve" | "revise";
    }[];
  };
  readonly createdAt: string;
}

/** Compact recap used as memory context when planning the *next* episode. */
export function recapOf(ep: Episode): string {
  return `Ep ${ep.number} "${ep.title}": ${ep.logline}`;
}
