import type { CharacterId, VoiceId } from "./ids.ts";

/**
 * A Character's *immutable identity*: the attributes that must never drift between
 * episodes. These are hashed into a deterministic identity seed (see prompt/identity.ts)
 * and rendered into a canonical description that is injected into every visual prompt
 * featuring this character. This is the concrete mechanism behind "every character
 * remains identical forever".
 */
export interface CharacterAppearance {
  readonly species: string; // "red fox", "human girl", "robot"
  readonly ageDescription: string; // "8 years old", "young adult"
  readonly build: string; // "small and round", "tall and lanky"
  readonly face: string; // distinguishing facial features
  readonly hair: string; // "fluffy orange fur with white tips"
  readonly eyes: string; // "large amber eyes"
  readonly outfit: string; // signature clothing, worn unless an episode overrides
  readonly accessories: readonly string[]; // "red scarf", "explorer backpack"
  readonly palette: readonly string[]; // dominant colors, e.g. ["#E8622C", "#FFFFFF"]
  /** Free-form description used verbatim as the identity fragment when set. Lets characters
   *  generated on the fly (Content Director) skip the structured fields while still flowing
   *  through the same identity-locking + consistency machinery. */
  readonly promptDescription?: string;
}

/** Mutable-per-episode traits that still belong to the character's memory. */
export interface CharacterPersonality {
  readonly traits: readonly string[]; // "curious", "brave", "impatient"
  readonly catchphrases: readonly string[];
  readonly speakingStyle: string; // "excitable, lots of questions"
  readonly relationships: Readonly<Record<string, string>>; // characterId -> relationship label
}

export interface Character {
  readonly id: CharacterId;
  readonly name: string;
  readonly voiceId: VoiceId;
  readonly appearance: CharacterAppearance;
  readonly personality: CharacterPersonality;
  /** Optional locked reference-image asset URI used for image-to-image consistency. */
  readonly referenceImageUri?: string;
  readonly createdAt: string;
}
