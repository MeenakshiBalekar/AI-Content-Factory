import type {
  Episode,
  EpisodeAsset,
  StoryBeat,
} from "../domain/episode.ts";
import { asEpisodeId, type ChannelId } from "../domain/ids.ts";
import {
  UnknownChannelError,
  type ChannelMemory,
  type MemoryStore,
} from "../memory/memory-store.ts";
import { PromptComposer } from "../prompt/prompt-composer.ts";
import type { ProviderRegistry } from "../providers/provider.ts";
import type { QualityEngine } from "../quality/quality-engine.ts";
import { buildReport, hasRejects, type Finding, type StageQuality } from "../quality/report.ts";
import { compileWorkflow, type WorkflowDefinition } from "../workflow/workflow.ts";
import type { CreativeCrew, CreativeBrief } from "../agents/crew.ts";
import {
  DEFAULT_PRODUCTION_PLAN,
  type ProductionStage,
} from "./production-plan.ts";
import { StoryPlanner } from "./story-planner.ts";

export interface CreateEpisodeOptions {
  /** Free-text nudge, e.g. "make it about sharing". Optional — memory supplies the rest. */
  readonly brief?: string;
  /** Override the auto-incremented episode number (otherwise last + 1). */
  readonly number?: number;
  /** Workflow to execute (Module 5). Validated and topologically ordered; defaults to the
   *  orchestrator's configured plan (the standard pipeline). */
  readonly workflow?: WorkflowDefinition;
  /** Pre-built content (from the Content Understanding layer): a beat sheet + title/logline
   *  derived from arbitrary user input. When supplied, the deterministic StoryPlanner is
   *  bypassed and the media pipeline renders exactly these scenes. */
  readonly content?: {
    readonly beats: readonly StoryBeat[];
    readonly title: string;
    readonly logline: string;
  };
  readonly now?: () => Date;
}

/** A progress event emitted as each stage settles, for CLI/API streaming. */
export interface StageEvent {
  readonly stage: ProductionStage;
  readonly assets: readonly EpisodeAsset[];
  /** How many attempts the stage took (1 = first try) — present when quality gating is on. */
  readonly attempts?: number;
  /** Final-attempt findings — present when quality gating is on. */
  readonly findings?: readonly Finding[];
}

export interface OrchestratorOptions {
  /** When set, every stage's output is inspected and rejected output is regenerated. */
  readonly quality?: QualityEngine;
  /** Attempt budget per stage when quality gating is on (first try included). */
  readonly maxAttemptsPerStage?: number;
  /** When set, a multi-agent crew develops a creative brief before planning (Module 7). */
  readonly crew?: CreativeCrew;
}

/**
 * The Orchestrator is the Creative Director: given a channel id it loads all memory, decides
 * the next episode number, plans the story from the channel bible + recurring cast + previous
 * episode, then walks the production plan, composing every prompt from memory and dispatching
 * to the resolved provider. It records the exact prompt and output of every step for
 * auditability, persists the finished episode back into memory (so the next call knows about
 * it), and returns it. This is the "Create Episode 248" entry point.
 */
export class EpisodeOrchestrator {
  readonly #store: MemoryStore;
  readonly #registry: ProviderRegistry;
  readonly #plan: readonly ProductionStage[];
  readonly #quality: QualityEngine | undefined;
  readonly #maxAttempts: number;
  readonly #crew: CreativeCrew | undefined;

  constructor(
    store: MemoryStore,
    registry: ProviderRegistry,
    plan: readonly ProductionStage[] = DEFAULT_PRODUCTION_PLAN,
    opts: OrchestratorOptions = {},
  ) {
    this.#store = store;
    this.#registry = registry;
    this.#plan = plan;
    this.#quality = opts.quality;
    this.#maxAttempts = Math.max(1, opts.maxAttemptsPerStage ?? 3);
    this.#crew = opts.crew;
  }

  async createEpisode(
    channelId: ChannelId,
    opts: CreateEpisodeOptions = {},
    onStage?: (e: StageEvent) => void,
  ): Promise<Episode> {
    const memory = await this.#store.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);

    const now = opts.now ?? (() => new Date());
    const nextNumber =
      opts.number ??
      (memory.episodes.reduce((max, e) => Math.max(max, e.number), 0) + 1);

    const planner = new StoryPlanner(memory);
    const composer = new PromptComposer(memory);
    // Content Understanding layer: when a beat sheet is supplied (from arbitrary user input),
    // the media pipeline renders exactly those scenes; otherwise the deterministic StoryPlanner
    // generates a template arc from the channel's cast.
    const beats = opts.content ? opts.content.beats : planner.beats(nextNumber);

    // Module 7: a multi-agent crew develops a creative brief before planning. Skipped when the
    // content is supplied externally (the Content Director already did the authoring).
    let creativeBrief: CreativeBrief | undefined;
    if (this.#crew && !opts.content) {
      creativeBrief = await this.#crew.develop({
        channelPremise: memory.channel.premise,
        audience: memory.channel.audience,
        episodeNumber: nextNumber,
        previousTitle: memory.episodes.at(-1)?.title,
        provenHooks: memory.channel.performance.bestHooks,
        brief: opts.brief,
      });
    }

    const title = opts.content ? opts.content.title : planner.title(nextNumber);
    const baseLogline = opts.content ? opts.content.logline : planner.logline(nextNumber);
    const focus = opts.brief ? ` Focus: ${opts.brief}.` : "";
    const logline = creativeBrief
      ? `${baseLogline}${focus} Creative direction: ${creativeBrief.theme}`
      : `${baseLogline}${focus}`;

    const stageCtx = {
      memory,
      composer,
      beats,
      logline,
      title,
      episodeNumber: nextNumber,
      creativeBrief,
    };

    // A workflow (validated + topologically ordered) overrides the configured plan.
    const plan = opts.workflow ? compileWorkflow(opts.workflow) : this.#plan;

    const assets: EpisodeAsset[] = [];
    const stageQualities: StageQuality[] = [];
    for (const stage of plan) {
      let produced = await this.#runStage(stage, stageCtx);
      let attempts = 1;
      let findings: Finding[] = [];

      if (this.#quality) {
        findings = this.#quality.inspectStage(produced, { stage, memory, beats });
        // Reject → regenerate, within the attempt budget. Providers with any randomness
        // (or recovered transient failures) get a genuine second chance; deterministic
        // providers simply exhaust the budget and the failure is recorded honestly.
        while (this.#quality.shouldRegenerate(findings) && attempts < this.#maxAttempts) {
          produced = await this.#runStage(stage, stageCtx);
          attempts++;
          findings = this.#quality.inspectStage(produced, { stage, memory, beats });
        }
        stageQualities.push({
          kind: stage.kind,
          attempts,
          findings,
          passed: !hasRejects(findings),
        });
      }

      assets.push(...produced);
      onStage?.({
        stage,
        assets: produced,
        ...(this.#quality ? { attempts, findings } : {}),
      });
    }

    const episode: Episode = {
      id: asEpisodeId(`${channelId}-ep-${nextNumber}`),
      channelId,
      number: nextNumber,
      title,
      logline,
      beats,
      assets,
      ...(this.#quality ? { quality: buildReport(stageQualities) } : {}),
      ...(creativeBrief ? { creativeBrief } : {}),
      workflowId: opts.workflow?.id ?? "standard",
      createdAt: now().toISOString(),
    };

    await this.#store.appendEpisode(channelId, episode);
    return episode;
  }

  async #runStage(
    stage: ProductionStage,
    ctx: {
      memory: ChannelMemory;
      composer: PromptComposer;
      beats: readonly StoryBeat[];
      logline: string;
      title: string;
      episodeNumber: number;
      creativeBrief?: CreativeBrief | undefined;
    },
  ): Promise<EpisodeAsset[]> {
    const { composer, beats } = ctx;
    switch (stage.kind) {
      case "story": {
        // Close the learning loop: proven hooks (written into ChannelPerformance by the
        // analytics module from real metrics) steer the next episode's opening. When a crew
        // developed a brief (Module 7), its agreed hook leads.
        const perf = ctx.memory.channel.performance;
        const crewHook = ctx.creativeBrief
          ? `\nCrew hook (approved=${ctx.creativeBrief.approved}, rounds=${ctx.creativeBrief.rounds}): "${ctx.creativeBrief.hook}"`
          : "";
        const provenHooks = perf.bestHooks.length
          ? `\nProven high-retention hooks to emulate: ${perf.bestHooks.map((h) => `"${h}"`).join("; ")}` +
            (perf.avgViewDurationSec ? `\nChannel avg view duration: ${perf.avgViewDurationSec}s — front-load the payoff.` : "")
          : "";
        const prompt =
          `Channel: ${ctx.memory.channel.premise}\nAudience: ${ctx.memory.channel.audience}${crewHook}\n` +
          `Previous: ${ctx.memory.episodes.at(-1)?.title ?? "none"}${provenHooks}\n` +
          `Plan episode ${ctx.episodeNumber}: ${ctx.logline}`;
        const text = await this.#registry.text().generateText({ prompt, maxTokens: 400 });
        return [this.#ok(stage, "Story outline", prompt, this.#registry.text().name, { chars: text.length, learnedHooks: perf.bestHooks.length })];
      }
      case "script": {
        const prompt = beats
          .map((b) => `Beat ${b.index + 1}: ${b.summary}\n` + b.dialogue.map((d) => `  ${d.characterId}: ${d.line}`).join("\n"))
          .join("\n\n");
        await this.#registry.text().generateText({ prompt, maxTokens: 600 });
        return [this.#ok(stage, "Script & dialogue", prompt, this.#registry.text().name, { beats: beats.length })];
      }
      case "storyboard": {
        // No external call — the storyboard IS the beat sheet already bound to memory.
        return beats.map((b) =>
          this.#ok(stage, `Beat ${b.index + 1} board`, b.summary, "internal", { beat: b.index }),
        );
      }
      case "image": {
        const out: EpisodeAsset[] = [];
        for (const b of beats) {
          const { prompt, seed } = composer.imagePrompt(b);
          const aspect = stage.params?.aspect ?? ctx.memory.channel.style.aspectRatio;
          const asset = await this.#registry.image().generateImage({ prompt, seed, aspect });
          out.push(this.#done(stage, `Keyframe beat ${b.index + 1}`, prompt, asset.provider, asset.outputUri, { seed, beat: b.index, aspect }));
        }
        return out;
      }
      case "voice": {
        const out: EpisodeAsset[] = [];
        for (const b of beats) {
          for (const v of composer.voicePrompts(b)) {
            const asset = await this.#registry.audio().generateAudio({
              text: v.line,
              voiceRef: v.voiceRef,
              pitch: v.params.pitch,
              speed: v.params.speed,
              emotion: v.params.emotion,
            });
            out.push(
              this.#done(stage, `Line: ${v.characterId}`, v.line, asset.provider, asset.outputUri, {
                voice: v.voiceRef,
                emotion: v.params.emotion,
              }),
            );
          }
        }
        return out;
      }
      case "music": {
        const prompt = composer.musicPrompt();
        const asset = await this.#registry.audio().generateAudio({
          text: prompt,
          voiceRef: "music",
          pitch: 0,
          speed: 1,
          emotion: "neutral",
        });
        return [this.#done(stage, "Background music", prompt, asset.provider, asset.outputUri)];
      }
      case "video": {
        const out: EpisodeAsset[] = [];
        for (const b of beats) {
          const { prompt, seed } = composer.imagePrompt(b);
          const aspect = stage.params?.aspect ?? ctx.memory.channel.style.aspectRatio;
          const totalSec = stage.params?.durationSec ?? ctx.memory.channel.format.targetDurationSec;
          const asset = await this.#registry.video().generateVideo({
            prompt,
            seed,
            aspect,
            durationSec: Math.round(totalSec / beats.length),
          });
          out.push(this.#done(stage, `Animate beat ${b.index + 1}`, prompt, asset.provider, asset.outputUri, { seed, beat: b.index, aspect }));
        }
        return out;
      }
      case "subtitles": {
        // Wrap dialogue at 42 chars per line (readability), max 2 lines per cue — the
        // channel's subtitle style. The SubtitleInspector enforces the same rules.
        const wrap = (line: string): string => {
          if (line.length <= 42) return line;
          const words = line.split(/\s+/);
          const lines: string[] = [""];
          for (const w of words) {
            const cur = lines[lines.length - 1]!;
            if (cur && (cur + " " + w).length > 42) lines.push(w);
            else lines[lines.length - 1] = cur ? `${cur} ${w}` : w;
          }
          return lines.slice(0, 2).join("\n");
        };
        const srt = beats
          .flatMap((b) => b.dialogue.map((d) => d.line))
          .map((line, i) => `${i + 1}\n00:00:${String(i * 3).padStart(2, "0")},000 --> 00:00:${String(i * 3 + 2).padStart(2, "0")},500\n${wrap(line)}`)
          .join("\n\n");
        return [this.#ok(stage, "Subtitles (SRT)", srt, "internal", { cues: srt.split("\n\n").length })];
      }
      case "thumbnail": {
        const heroId = beats[0]?.characterIds[0];
        if (!heroId) return [this.#fail(stage, "Thumbnail", "no hero character")];
        // Caption is episode-specific (a 3-word hook from the title) so thumbnails differ
        // per episode, while style + hero identity stay locked by channel memory.
        const caption = ctx.title.split(/\s+/).slice(-3).join(" ");
        const { prompt, seed } = composer.thumbnailPrompt(heroId, caption);
        const aspect = stage.params?.aspect ?? ctx.memory.channel.style.aspectRatio;
        const asset = await this.#registry.image().generateImage({ prompt, seed, aspect });
        return [this.#done(stage, "Thumbnail", prompt, asset.provider, asset.outputUri, { seed, aspect })];
      }
      case "metadata": {
        const prompt = `Write YouTube title, description and 10 tags for "${ctx.title}" — ${ctx.logline}. Audience: ${ctx.memory.channel.audience}.`;
        await this.#registry.text().generateText({ prompt, maxTokens: 300 });
        return [this.#ok(stage, "YouTube metadata", prompt, this.#registry.text().name)];
      }
      default: {
        const _exhaustive: never = stage.kind;
        throw new Error(`Unhandled stage ${String(_exhaustive)}`);
      }
    }
  }

  #ok(
    stage: ProductionStage,
    label: string,
    prompt: string,
    provider: string,
    meta?: Record<string, string | number>,
  ): EpisodeAsset {
    return { kind: stage.kind, label, prompt, provider, status: "succeeded", ...(meta ? { meta } : {}) };
  }

  #done(
    stage: ProductionStage,
    label: string,
    prompt: string,
    provider: string,
    outputUri: string,
    meta?: Record<string, string | number>,
  ): EpisodeAsset {
    return {
      kind: stage.kind,
      label,
      prompt,
      provider,
      status: "succeeded",
      outputUri,
      ...(meta ? { meta } : {}),
    };
  }

  #fail(stage: ProductionStage, label: string, error: string): EpisodeAsset {
    return { kind: stage.kind, label, prompt: "", provider: "none", status: "failed", error };
  }
}
