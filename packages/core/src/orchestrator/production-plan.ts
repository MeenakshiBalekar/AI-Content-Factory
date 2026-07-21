import type { AssetKind } from "../domain/episode.ts";

/** A pipeline stage. The default plan mirrors the workflow in the brief:
 *  story → script → storyboard → image → voice → music → video → subtitles → thumbnail → metadata. */
export interface ProductionStage {
  readonly kind: AssetKind;
  readonly label: string;
  /** Capability the stage needs; drives which provider the registry resolves. */
  readonly capability: "text" | "image" | "audio" | "video" | "none";
}

export const DEFAULT_PRODUCTION_PLAN: readonly ProductionStage[] = [
  { kind: "story", label: "Story outline", capability: "text" },
  { kind: "script", label: "Script & dialogue", capability: "text" },
  { kind: "storyboard", label: "Storyboard beats", capability: "none" },
  { kind: "image", label: "Key frames per beat", capability: "image" },
  { kind: "voice", label: "Voice lines per beat", capability: "audio" },
  { kind: "music", label: "Background music", capability: "audio" },
  { kind: "video", label: "Animate beats", capability: "video" },
  { kind: "subtitles", label: "Subtitles", capability: "none" },
  { kind: "thumbnail", label: "Thumbnail", capability: "image" },
  { kind: "metadata", label: "Title, description, tags", capability: "text" },
];
