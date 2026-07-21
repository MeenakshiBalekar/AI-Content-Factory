import type { StoryBeat } from "../domain/episode.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";
import { identityFragment, identitySeed, paletteToken } from "./identity.ts";
import type { CharacterId } from "../domain/ids.ts";

/**
 * Turns channel memory + a story beat into concrete, provider-ready prompts. Every prompt
 * is assembled from memory so that style, characters, and locations stay consistent without
 * the user restating them. Nothing here is stochastic — same memory in, same prompt out.
 */
export class PromptComposer {
  readonly #memory: ChannelMemory;

  constructor(memory: ChannelMemory) {
    this.#memory = memory;
  }

  #character(id: CharacterId) {
    const c = this.#memory.characters[id];
    if (!c) throw new Error(`Beat references unknown character "${id}"`);
    return c;
  }

  /** The always-present style preamble derived from the channel bible. */
  stylePreamble(): string {
    const s = this.#memory.channel.style;
    return `Style: ${s.animationStyle}; color grade ${s.colorGrade}; ${s.aspectRatio} ${s.resolution}.`;
  }

  /** Image prompt for a beat: style + every character's locked identity + scene memory. */
  imagePrompt(beat: StoryBeat): { prompt: string; seed: number } {
    const env = this.#memory.environments[beat.environmentId];
    if (!env) throw new Error(`Beat references unknown environment "${beat.environmentId}"`);

    const characters = beat.characterIds.map((id) => this.#character(id));
    const identities = characters.map((c) => identityFragment(c)).join(" ");
    // Combine per-character seeds into one stable scene seed.
    const seed = characters.reduce(
      (acc, c) => (acc ^ identitySeed(this.#memory.channel.id, c)) >>> 0,
      0x9e3779b9,
    ) % 2_147_483_647;

    const prompt = [
      this.stylePreamble(),
      `Scene: ${beat.summary}`,
      `Setting: ${env.description}. Lighting: ${env.lighting}. Props: ${env.props.join(", ")}. Mood: ${env.mood}.`,
      `Camera: ${env.cameraLanguage}. Time: ${env.timeOfDay}, weather ${env.weather}.`,
      `Characters (keep exactly consistent): ${identities}`,
    ].join("\n");

    return { prompt, seed };
  }

  /** Per-line voice prompt with the locked voice profile resolved for the speaker. */
  voicePrompts(beat: StoryBeat): {
    characterId: CharacterId;
    line: string;
    voiceRef: string;
    params: { pitch: number; speed: number; energy: number; emotion: string };
  }[] {
    return beat.dialogue.map((d) => {
      const character = this.#character(d.characterId);
      const voice = this.#memory.voices[character.voiceId];
      if (!voice) throw new Error(`Character "${character.id}" has unknown voice`);
      return {
        characterId: d.characterId,
        line: d.line,
        voiceRef: voice.providerVoiceRef,
        params: {
          pitch: voice.pitch,
          speed: voice.speed,
          energy: voice.energy,
          emotion: voice.emotions[0] ?? "neutral",
        },
      };
    });
  }

  /** Background-music prompt from channel format memory. */
  musicPrompt(): string {
    return `Instrumental background music, ${this.#memory.channel.format.backgroundMusicMood}, loops cleanly, no vocals.`;
  }

  /** Thumbnail prompt: hero character + channel thumbnail style + palette token. */
  thumbnailPrompt(heroId: CharacterId, hookText: string): { prompt: string; seed: number } {
    const hero = this.#character(heroId);
    const s = this.#memory.channel.style;
    return {
      prompt: [
        `Thumbnail. ${s.thumbnailStyle}.`,
        `Hero: ${identityFragment(hero)}`,
        `Big expressive emotion. Caption text: "${hookText}".`,
        `Palette: ${paletteToken(hero)}.`,
      ].join("\n"),
      seed: identitySeed(this.#memory.channel.id, hero),
    };
  }
}
