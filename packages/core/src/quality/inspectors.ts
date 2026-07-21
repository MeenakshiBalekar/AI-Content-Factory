import type { EpisodeAsset, StoryBeat } from "../domain/episode.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";
import type { ProductionStage } from "../orchestrator/production-plan.ts";
import { identityFragment } from "../prompt/identity.ts";
import type { Finding } from "./report.ts";

/**
 * Stage inspectors (Module 4). Each inspector is a pure function of the produced assets +
 * channel memory, so every check is deterministic and unit-testable. Pixel-level inspection
 * (blur, lip-sync, framing) requires a vision provider and plugs in as another Inspector —
 * the engine doesn't care whether a finding came from a heuristic or a model.
 */

export interface StageContext {
  readonly stage: ProductionStage;
  readonly memory: ChannelMemory;
  readonly beats: readonly StoryBeat[];
}

export interface Inspector {
  readonly name: string;
  /** Which stage kinds this inspector applies to. */
  appliesTo(kind: ProductionStage["kind"]): boolean;
  inspect(assets: readonly EpisodeAsset[], ctx: StageContext): Finding[];
}

/** Media stages must produce a usable output URI and a non-empty prompt. */
export class CompletenessInspector implements Inspector {
  readonly name = "completeness";
  static readonly #MEDIA = new Set(["image", "voice", "music", "video", "thumbnail"]);

  appliesTo(): boolean {
    return true;
  }

  inspect(assets: readonly EpisodeAsset[], ctx: StageContext): Finding[] {
    const findings: Finding[] = [];
    for (const a of assets) {
      if (a.status === "failed") {
        findings.push({
          inspector: this.name,
          severity: "reject",
          code: "stage-failed",
          message: `asset failed: ${a.error ?? "unknown error"}`,
          assetLabel: a.label,
        });
        continue;
      }
      if (CompletenessInspector.#MEDIA.has(a.kind) && !a.outputUri) {
        findings.push({
          inspector: this.name,
          severity: "reject",
          code: "missing-output",
          message: `${a.kind} asset has no output URI`,
          assetLabel: a.label,
        });
      }
      if (!a.prompt.trim() && ctx.stage.capability !== "none") {
        findings.push({
          inspector: this.name,
          severity: "reject",
          code: "empty-prompt",
          message: "asset was generated from an empty prompt",
          assetLabel: a.label,
        });
      }
    }
    return findings;
  }
}

/**
 * The core consistency guarantee, enforced: every visual prompt must contain the locked
 * identity fragment of every character in its beat, plus the channel style preamble. If a
 * prompt was assembled without them (a composer regression, a plugin overriding prompts,
 * a truncation), the character WILL drift — so this is a reject.
 */
export class IdentityConsistencyInspector implements Inspector {
  readonly name = "identity-consistency";

  appliesTo(kind: ProductionStage["kind"]): boolean {
    return kind === "image" || kind === "video";
  }

  inspect(assets: readonly EpisodeAsset[], ctx: StageContext): Finding[] {
    const findings: Finding[] = [];
    for (const a of assets) {
      const beatIndex = typeof a.meta?.beat === "number" ? a.meta.beat : undefined;
      const beat = beatIndex !== undefined ? ctx.beats[beatIndex] : undefined;
      if (!beat) {
        findings.push({
          inspector: this.name,
          severity: "warn",
          code: "unlinked-beat",
          message: "visual asset is not linked to a beat (meta.beat missing) — cannot verify identity",
          assetLabel: a.label,
        });
        continue;
      }
      for (const characterId of beat.characterIds) {
        const character = ctx.memory.characters[characterId];
        if (!character) continue; // composer already throws for unknown ids
        if (!a.prompt.includes(identityFragment(character))) {
          findings.push({
            inspector: this.name,
            severity: "reject",
            code: "identity-missing",
            message: `prompt is missing the locked identity fragment for "${character.name}" — character would drift`,
            assetLabel: a.label,
          });
        }
      }
      if (!a.prompt.includes(ctx.memory.channel.style.animationStyle)) {
        findings.push({
          inspector: this.name,
          severity: "reject",
          code: "style-missing",
          message: "prompt is missing the channel animation style — look would drift",
          assetLabel: a.label,
        });
      }
    }
    return findings;
  }
}

/** Parses and validates the SRT produced by the subtitles stage. */
export class SubtitleInspector implements Inspector {
  readonly name = "subtitles";
  static readonly #TIME = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
  static readonly #MAX_LINES = 2;
  static readonly #MAX_CHARS_PER_LINE = 42;

  appliesTo(kind: ProductionStage["kind"]): boolean {
    return kind === "subtitles";
  }

  #ms(h: string, m: string, s: string, ms: string): number {
    return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
  }

  inspect(assets: readonly EpisodeAsset[]): Finding[] {
    const findings: Finding[] = [];
    for (const a of assets) {
      const cues = a.prompt.split(/\n\n+/).filter((c) => c.trim());
      let lastEnd = -1;
      cues.forEach((cue, i) => {
        const lines = cue.split("\n");
        const [index, timing, ...text] = lines;
        if (Number(index) !== i + 1) {
          findings.push({
            inspector: this.name,
            severity: "reject",
            code: "srt-numbering",
            message: `cue ${i + 1} is numbered "${index}" — SRT numbering must be sequential`,
            assetLabel: a.label,
          });
        }
        const m = timing ? SubtitleInspector.#TIME.exec(timing) : null;
        if (!m) {
          findings.push({
            inspector: this.name,
            severity: "reject",
            code: "srt-timing-format",
            message: `cue ${i + 1} has a malformed timing line: "${timing ?? ""}"`,
            assetLabel: a.label,
          });
        } else {
          const start = this.#ms(m[1]!, m[2]!, m[3]!, m[4]!);
          const end = this.#ms(m[5]!, m[6]!, m[7]!, m[8]!);
          if (end <= start) {
            findings.push({
              inspector: this.name,
              severity: "reject",
              code: "srt-timing-order",
              message: `cue ${i + 1} ends before it starts`,
              assetLabel: a.label,
            });
          }
          if (start < lastEnd) {
            findings.push({
              inspector: this.name,
              severity: "reject",
              code: "srt-overlap",
              message: `cue ${i + 1} overlaps the previous cue`,
              assetLabel: a.label,
            });
          }
          lastEnd = end;
        }
        if (text.length === 0 || text.every((t) => !t.trim())) {
          findings.push({
            inspector: this.name,
            severity: "reject",
            code: "srt-empty-cue",
            message: `cue ${i + 1} has no text`,
            assetLabel: a.label,
          });
        }
        if (text.length > SubtitleInspector.#MAX_LINES) {
          findings.push({
            inspector: this.name,
            severity: "reject",
            code: "srt-too-many-lines",
            message: `cue ${i + 1} has ${text.length} lines (max ${SubtitleInspector.#MAX_LINES} per channel style)`,
            assetLabel: a.label,
          });
        }
        for (const line of text) {
          if (line.length > SubtitleInspector.#MAX_CHARS_PER_LINE) {
            findings.push({
              inspector: this.name,
              severity: "warn",
              code: "srt-line-length",
              message: `cue ${i + 1} line exceeds ${SubtitleInspector.#MAX_CHARS_PER_LINE} chars — may wrap awkwardly`,
              assetLabel: a.label,
            });
          }
        }
      });
    }
    return findings;
  }
}

/** Every dialogue line in the beat sheet must have exactly one generated voice asset. */
export class VoiceCoverageInspector implements Inspector {
  readonly name = "voice-coverage";

  appliesTo(kind: ProductionStage["kind"]): boolean {
    return kind === "voice";
  }

  inspect(assets: readonly EpisodeAsset[], ctx: StageContext): Finding[] {
    const expected = ctx.beats.reduce((n, b) => n + b.dialogue.length, 0);
    if (assets.length === expected) return [];
    return [
      {
        inspector: this.name,
        severity: "reject",
        code: "voice-line-mismatch",
        message: `script has ${expected} dialogue lines but ${assets.length} voice assets were produced`,
      },
    ];
  }
}

/** Metadata sanity: a title that fits YouTube's display limit is a hard requirement. */
export class MetadataInspector implements Inspector {
  readonly name = "metadata";
  static readonly #MAX_TITLE = 70;

  appliesTo(kind: ProductionStage["kind"]): boolean {
    return kind === "metadata" || kind === "thumbnail";
  }

  inspect(assets: readonly EpisodeAsset[], ctx: StageContext): Finding[] {
    const findings: Finding[] = [];
    for (const a of assets) {
      if (a.kind === "thumbnail" && !a.prompt.includes(ctx.memory.channel.style.thumbnailStyle)) {
        findings.push({
          inspector: this.name,
          severity: "reject",
          code: "thumbnail-style-missing",
          message: "thumbnail prompt is missing the channel's locked thumbnail style",
          assetLabel: a.label,
        });
      }
      if (a.kind === "metadata") {
        const titleMatch = /"([^"]+)"/.exec(a.prompt);
        const title = titleMatch?.[1];
        if (title && title.length > MetadataInspector.#MAX_TITLE) {
          findings.push({
            inspector: this.name,
            severity: "warn",
            code: "title-too-long",
            message: `title is ${title.length} chars — YouTube truncates around ${MetadataInspector.#MAX_TITLE}`,
            assetLabel: a.label,
          });
        }
      }
    }
    return findings;
  }
}

/** The default inspector suite. Vision-model inspectors join this list in Module 4.1. */
export function defaultInspectors(): Inspector[] {
  return [
    new CompletenessInspector(),
    new IdentityConsistencyInspector(),
    new SubtitleInspector(),
    new VoiceCoverageInspector(),
    new MetadataInspector(),
  ];
}
