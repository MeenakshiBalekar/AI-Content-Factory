import type { Episode } from "../domain/episode.ts";
import type { ChannelId } from "../domain/ids.ts";
import type { MemoryStore } from "../memory/memory-store.ts";
import { EpisodeOrchestrator } from "../orchestrator/orchestrator.ts";
import type { ProviderRegistry } from "../providers/provider.ts";
import { QualityEngine } from "../quality/quality-engine.ts";
import { ContentDirector, type DirectOptions } from "./content-director.ts";
import { storyboardToPlan } from "./storyboard-adapter.ts";
import type { Storyboard } from "./storyboard.ts";

/**
 * The end-to-end generic entry point: arbitrary user input (rhyme/song/story) → a video-ready
 * episode. It runs the Content Understanding layer (ContentDirector) to produce a Storyboard,
 * bridges it into a generic synthetic channel + beat sheet, persists it, and drives the
 * existing media layer (orchestrator) to generate all assets. Rendering to MP4 is a separate
 * step via RenderService (unchanged), so the two layers stay cleanly separated.
 */
export interface CreateFromContentResult {
  readonly channelId: ChannelId;
  readonly storyboard: Storyboard;
  readonly episode: Episode;
}

export class ContentService {
  readonly #store: MemoryStore;
  readonly #registry: ProviderRegistry;

  constructor(store: MemoryStore, registry: ProviderRegistry) {
    this.#store = store;
    this.#registry = registry;
  }

  async createFromContent(input: string, opts: DirectOptions = {}): Promise<CreateFromContentResult> {
    // 1) Content Understanding — uses the self-hosted text model if present, else deterministic.
    const director = new ContentDirector(this.#tryText());
    const storyboard = await director.direct(input, opts);

    // 2) Bridge to a generic synthetic channel + beat sheet.
    const plan = storyboardToPlan(storyboard);
    await this.#store.save(plan.memory);

    // 3) Media layer generates all stage assets for exactly these scenes.
    const orchestrator = new EpisodeOrchestrator(this.#store, this.#registry, undefined, {
      quality: new QualityEngine(),
    });
    const episode = await orchestrator.createEpisode(plan.memory.channel.id, {
      number: 1,
      content: { beats: plan.beats, title: plan.title, logline: plan.logline },
    });

    return { channelId: plan.memory.channel.id, storyboard, episode };
  }

  #tryText() {
    try {
      return this.#registry.text();
    } catch {
      return undefined; // no text provider registered -> deterministic decomposition
    }
  }
}
