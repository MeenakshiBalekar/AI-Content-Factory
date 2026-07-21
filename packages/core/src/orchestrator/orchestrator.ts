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
  readonly now?: () => Date;
}

/** A progress event emitted as each stage runs, for CLI/API streaming. */
export interface StageEvent {
  readonly stage: ProductionStage;
  readonly assets: readonly EpisodeAsset[];
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

  constructor(
    store: MemoryStore,
    registry: ProviderRegistry,
    plan: readonly ProductionStage[] = DEFAULT_PRODUCTION_PLAN,
  ) {
    this.#store = store;
    this.#registry = registry;
    this.#plan = plan;
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
    const beats = planner.beats(nextNumber);
    const logline = opts.brief
      ? `${planner.logline(nextNumber)} Focus: ${opts.brief}.`
      : planner.logline(nextNumber);

    const assets: EpisodeAsset[] = [];
    for (const stage of this.#plan) {
      const produced = await this.#runStage(stage, {
        memory,
        composer,
        beats,
        logline,
        title: planner.title(nextNumber),
        episodeNumber: nextNumber,
      });
      assets.push(...produced);
      onStage?.({ stage, assets: produced });
    }

    const episode: Episode = {
      id: asEpisodeId(`${channelId}-ep-${nextNumber}`),
      channelId,
      number: nextNumber,
      title: planner.title(nextNumber),
      logline,
      beats,
      assets,
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
    },
  ): Promise<EpisodeAsset[]> {
    const { composer, beats } = ctx;
    switch (stage.kind) {
      case "story": {
        const prompt = `Channel: ${ctx.memory.channel.premise}\nAudience: ${ctx.memory.channel.audience}\nPrevious: ${ctx.memory.episodes.at(-1)?.title ?? "none"}\nPlan episode ${ctx.episodeNumber}: ${ctx.logline}`;
        const text = await this.#registry.text().generateText({ prompt, maxTokens: 400 });
        return [this.#ok(stage, "Story outline", prompt, this.#registry.text().name, { chars: text.length })];
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
          const asset = await this.#registry.image().generateImage({
            prompt,
            seed,
            aspect: ctx.memory.channel.style.aspectRatio,
          });
          out.push(this.#done(stage, `Keyframe beat ${b.index + 1}`, prompt, asset.provider, asset.outputUri, { seed }));
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
          const asset = await this.#registry.video().generateVideo({
            prompt,
            seed,
            aspect: ctx.memory.channel.style.aspectRatio,
            durationSec: Math.round(ctx.memory.channel.format.targetDurationSec / beats.length),
          });
          out.push(this.#done(stage, `Animate beat ${b.index + 1}`, prompt, asset.provider, asset.outputUri, { seed }));
        }
        return out;
      }
      case "subtitles": {
        const srt = beats
          .flatMap((b) => b.dialogue.map((d) => d.line))
          .map((line, i) => `${i + 1}\n00:00:${String(i * 3).padStart(2, "0")},000 --> 00:00:${String(i * 3 + 2).padStart(2, "0")},500\n${line}`)
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
        const asset = await this.#registry.image().generateImage({
          prompt,
          seed,
          aspect: ctx.memory.channel.style.aspectRatio,
        });
        return [this.#done(stage, "Thumbnail", prompt, asset.provider, asset.outputUri, { seed })];
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
