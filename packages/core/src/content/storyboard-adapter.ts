import type { Channel } from "../domain/channel.ts";
import type { Character } from "../domain/character.ts";
import type { Environment } from "../domain/environment.ts";
import type { StoryBeat } from "../domain/episode.ts";
import type { VoiceProfile } from "../domain/voice.ts";
import {
  asChannelId,
  asCharacterId,
  asEnvironmentId,
  asVoiceId,
  slugify,
  type CharacterId,
  type EnvironmentId,
} from "../domain/ids.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";
import type { Storyboard } from "./storyboard.ts";

/**
 * Bridges the two layers: converts a content-derived Storyboard into a generic, synthetic
 * ChannelMemory + beat sheet that the existing media layer (orchestrator + render) consumes
 * unchanged. The cast, environments, and scenes all come from the Storyboard — i.e. from user
 * input — so nothing here is tied to any specific character. The Channel/Character schemas are
 * just generic containers; each character carries its free-form `promptDescription`.
 */

export interface ContentEpisodePlan {
  readonly memory: ChannelMemory;
  readonly title: string;
  readonly logline: string;
  readonly beats: readonly StoryBeat[];
}

const DEFAULT_VOICE_REFS = [
  "voice:bright-child-01",
  "voice:warm-child-02",
  "voice:gentle-narrator-03",
];

export function storyboardToPlan(sb: Storyboard, now = new Date().toISOString()): ContentEpisodePlan {
  const channelId = asChannelId(slugify(sb.title) || "story");

  // --- cast ---
  const characters: Record<CharacterId, Character> = {};
  const voices: Record<string, VoiceProfile> = {};
  sb.characters.forEach((spec, i) => {
    const cid = asCharacterId(slugify(spec.name));
    const vid = asVoiceId(`${slugify(spec.name)}-voice`);
    voices[vid] = {
      id: vid,
      label: `${spec.name} — ${spec.voice}`,
      providerVoiceRef: DEFAULT_VOICE_REFS[i % DEFAULT_VOICE_REFS.length]!,
      language: "en-US",
      accent: "neutral",
      pitch: 2,
      speed: 1.0,
      energy: 0.85,
      emotions: ["happy", "excited", "neutral"],
    };
    characters[cid] = {
      id: cid,
      name: spec.name,
      voiceId: vid,
      appearance: {
        species: "",
        ageDescription: "",
        build: "",
        face: "",
        hair: "",
        eyes: "",
        outfit: "",
        accessories: [],
        palette: [...spec.palette],
        promptDescription: spec.description, // <- the generic, content-driven identity
      },
      personality: {
        traits: ["cheerful"],
        catchphrases: [],
        speakingStyle: spec.voice,
        relationships: {},
      },
      createdAt: now,
    };
  });

  // --- environments (unique by description) ---
  const environments: Record<EnvironmentId, Environment> = {};
  const envIdByDesc = new Map<string, EnvironmentId>();
  const envId = (desc: string): EnvironmentId => {
    const existing = envIdByDesc.get(desc);
    if (existing) return existing;
    const id = asEnvironmentId(`${slugify(desc).slice(0, 40) || "scene"}-${envIdByDesc.size}`);
    envIdByDesc.set(desc, id);
    environments[id] = {
      id,
      name: desc,
      description: desc,
      lighting: "bright, soft, even children's-book lighting",
      props: [],
      materials: [],
      mood: "cheerful and playful",
      cameraLanguage: "friendly eye-level framing with gentle movement",
      timeOfDay: "day",
      weather: "clear",
    };
    return id;
  };

  // --- beats (one per scene) ---
  const charIds = new Set(Object.keys(characters));
  const firstCharId = Object.keys(characters)[0] as CharacterId | undefined;
  const beats: StoryBeat[] = sb.scenes.map((scene) => {
    const sceneCharIds = scene.characters
      .map((n) => asCharacterId(slugify(n)))
      .filter((id) => charIds.has(id));
    const cast = sceneCharIds.length ? sceneCharIds : firstCharId ? [firstCharId] : [];
    const speaker = cast[0];
    return {
      index: scene.index,
      summary: `${scene.visual}. ${scene.action}`,
      characterIds: cast,
      environmentId: envId(scene.environment),
      dialogue: speaker ? [{ characterId: speaker, line: scene.lyrics }] : [],
    };
  });

  const channel: Channel = {
    id: channelId,
    name: sb.title,
    premise: sb.sourceText,
    audience: "children and families",
    language: "en-US",
    style: {
      animationStyle: sb.style,
      aspectRatio: sb.aspectRatio,
      resolution: "1080p",
      colorGrade: "bright, high-key, cheerful",
      thumbnailStyle: "big friendly character, bold 3-word caption",
      subtitleStyle: "bottom center, rounded, max 2 lines",
    },
    format: {
      targetDurationSec: Math.max(12, sb.scenes.length * 4),
      backgroundMusicMood: sb.song.mood,
      hookPattern: "open on the most colorful, energetic moment",
    },
    performance: { bestHooks: [], avgViewDurationSec: 0, notes: [] },
    schedule: { cadence: "on demand", platforms: ["youtube-kids"] },
    createdAt: now,
  };

  return {
    memory: { channel, characters, voices, environments, episodes: [] },
    title: sb.title,
    logline: sb.sourceText.replace(/\s+/g, " ").trim().slice(0, 160),
    beats,
  };
}
