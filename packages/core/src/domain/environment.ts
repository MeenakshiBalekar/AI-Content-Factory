import type { EnvironmentId } from "./ids.ts";

/**
 * A recurring location. Scene memory keeps sets visually consistent — the same treehouse
 * has the same lighting, props, and camera language every time it appears.
 */
export interface Environment {
  readonly id: EnvironmentId;
  readonly name: string;
  readonly description: string; // "cozy treehouse interior at golden hour"
  readonly lighting: string; // "warm golden-hour rim light from the window"
  readonly props: readonly string[]; // "acorn lantern", "rope ladder", "map wall"
  readonly materials: readonly string[]; // "worn oak planks", "woven grass rug"
  readonly mood: string; // "safe, adventurous, warm"
  readonly cameraLanguage: string; // "eye-level medium shots, gentle handheld"
  readonly timeOfDay: string; // "golden hour", "night"
  readonly weather: string; // "clear", "light rain"
}
