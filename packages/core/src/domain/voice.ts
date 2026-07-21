import type { VoiceId } from "./ids.ts";

/**
 * A locked voice identity. The same VoiceProfile is resolved for a character in every
 * episode, so a character always sounds the same. Real TTS/voice-clone providers
 * (ElevenLabs, Cartesia, PlayHT) map `providerVoiceRef` to their own voice handle.
 */
export interface VoiceProfile {
  readonly id: VoiceId;
  readonly label: string;
  /** Provider-agnostic reference resolved by a voice provider adapter to its own id. */
  readonly providerVoiceRef: string;
  readonly language: string; // BCP-47, e.g. "en-US"
  readonly accent: string; // "neutral", "british", "southern-us"
  readonly pitch: number; // semitone offset from provider default, -12..12
  readonly speed: number; // rate multiplier, 0.5..2.0
  readonly energy: number; // 0..1 baseline expressiveness
  /** Named emotion presets the director can request per line. */
  readonly emotions: readonly string[]; // "neutral", "excited", "sad", "whisper"
}

export const DEFAULT_EMOTION = "neutral";

export function clampVoice(v: VoiceProfile): VoiceProfile {
  const clamp = (n: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, n));
  return {
    ...v,
    pitch: clamp(v.pitch, -12, 12),
    speed: clamp(v.speed, 0.5, 2.0),
    energy: clamp(v.energy, 0, 1),
  };
}
