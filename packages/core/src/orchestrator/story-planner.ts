import type { StoryBeat } from "../domain/episode.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";
import type { CharacterId, EnvironmentId } from "../domain/ids.ts";

/**
 * Turns channel memory into a structured beat sheet. This is deliberately deterministic so
 * the kernel is testable; a real deployment routes the logline through the Story/Script AI
 * providers, but the *shape* it must return (beats bound to remembered characters and
 * locations) stays exactly this. The planner threads the previous episode's recap so stories
 * build on each other instead of resetting.
 */
export class StoryPlanner {
  readonly #memory: ChannelMemory;

  constructor(memory: ChannelMemory) {
    this.#memory = memory;
  }

  #hero(): CharacterId {
    const ids = Object.keys(this.#memory.characters) as CharacterId[];
    const hero = ids[0];
    if (!hero) throw new Error("Channel has no characters — cannot plan a story");
    return hero;
  }

  #supporting(): CharacterId[] {
    const ids = Object.keys(this.#memory.characters) as CharacterId[];
    return ids.slice(1);
  }

  #environments(): EnvironmentId[] {
    const ids = Object.keys(this.#memory.environments) as EnvironmentId[];
    if (ids.length === 0) throw new Error("Channel has no environments — cannot plan a story");
    return ids;
  }

  logline(episodeNumber: number): string {
    const hero = this.#memory.characters[this.#hero()]!;
    const last = this.#memory.episodes.at(-1);
    const previously = last ? ` Following on from "${last.title}",` : "";
    const goal = hero.personality.traits[0] ?? "curious";
    return `${previously} ${hero.name}'s ${goal} spirit leads to a new adventure (episode ${episodeNumber}).`.trim();
  }

  title(episodeNumber: number): string {
    const hero = this.#memory.characters[this.#hero()]!;
    const env = this.#memory.environments[this.#environments()[episodeNumber % this.#environments().length]!]!;
    return `${hero.name} and the ${env.name}`;
  }

  /** A three-act beat sheet (setup / challenge / resolution) bound to real memory. */
  beats(episodeNumber: number): StoryBeat[] {
    const heroId = this.#hero();
    const hero = this.#memory.characters[heroId]!;
    const supporting = this.#supporting();
    const envs = this.#environments();
    const pick = (i: number): EnvironmentId => envs[(episodeNumber + i) % envs.length]!;

    const heroLine = (fallback: string): string =>
      hero.personality.catchphrases[0] ?? fallback;

    const cast: CharacterId[] = supporting.length ? [heroId, supporting[0]!] : [heroId];
    const secondary = supporting[0];

    return [
      {
        index: 0,
        summary: `${hero.name} sets out, full of ${hero.personality.traits[0] ?? "wonder"}.`,
        characterIds: cast,
        environmentId: pick(0),
        dialogue: [{ characterId: heroId, line: heroLine("Let's go exploring!") }],
      },
      {
        index: 1,
        summary: `A challenge appears and ${hero.name} must think it through.`,
        characterIds: cast,
        environmentId: pick(1),
        dialogue: secondary
          ? [
              { characterId: secondary, line: "That looks tricky — what do we do?" },
              { characterId: heroId, line: "Every problem has a first step. Let's find it." },
            ]
          : [{ characterId: heroId, line: "Every problem has a first step. Let's find it." }],
      },
      {
        index: 2,
        summary: `${hero.name} succeeds and shares the lesson of the day.`,
        characterIds: cast,
        environmentId: pick(0),
        dialogue: [{ characterId: heroId, line: "We did it — together, one step at a time!" }],
      },
    ];
  }
}
