import type { ChannelMemory } from "../memory/memory-store.ts";
import {
  asChannelId,
  asCharacterId,
  asEnvironmentId,
  asVoiceId,
} from "../domain/ids.ts";

/**
 * A fully-populated sample channel used by the CLI `seed` command and by tests. It exercises
 * every part of the memory model: brand/style, a locked cast with appearances and voices, and
 * recurring environments. This is the kind of memory that lets "Create Episode N" run with no
 * extra input.
 */
export function sampleChannel(now = "2026-07-21T00:00:00.000Z"): ChannelMemory {
  const channelId = asChannelId("tiny-explorers");
  const miloId = asCharacterId("milo");
  const beeId = asCharacterId("bea");
  const miloVoice = asVoiceId("milo-voice");
  const beaVoice = asVoiceId("bea-voice");
  const treehouse = asEnvironmentId("treehouse");
  const meadow = asEnvironmentId("meadow");

  return {
    channel: {
      id: channelId,
      name: "Tiny Explorers",
      premise:
        "A gentle preschool adventure series where Milo the fox and Bea the bee solve small problems with curiosity and teamwork, teaching one simple life lesson per episode.",
      audience: "kids 4-7 and their parents",
      language: "en-US",
      style: {
        animationStyle: "soft 3D, rounded shapes, pastel storybook look",
        aspectRatio: "16:9",
        resolution: "4k",
        colorGrade: "warm, high-key, gentle contrast",
        thumbnailStyle: "big expressive hero face, 3-word caption, sunny yellow accent bar",
        subtitleStyle: "bottom center, rounded white, max 2 lines",
      },
      format: {
        targetDurationSec: 180,
        backgroundMusicMood: "gentle ukulele and glockenspiel, playful and warm",
        hookPattern: "open on the hero mid-question, promise a tiny mystery in the first 3 seconds",
      },
      performance: {
        bestHooks: ["What's THAT sound?", "Uh oh — a wobbly bridge!"],
        avgViewDurationSec: 142,
        notes: ["retention dips at the 90s mark — keep act 2 under 45s"],
      },
      schedule: {
        cadence: "daily 16:00 America/Los_Angeles",
        platforms: ["youtube", "youtube-shorts"],
      },
      createdAt: now,
    },
    characters: {
      [miloId]: {
        id: miloId,
        name: "Milo",
        voiceId: miloVoice,
        appearance: {
          species: "red fox cub",
          ageDescription: "6 years old",
          build: "small and round",
          face: "bright and friendly with a little black nose",
          hair: "fluffy orange fur with a cream chest and white-tipped tail",
          eyes: "large amber eyes",
          outfit: "teal explorer vest with brass buttons",
          accessories: ["red scarf", "tiny leather map satchel"],
          palette: ["#E8622C", "#FFF3E0", "#1F8A8A"],
        },
        personality: {
          traits: ["curious", "brave", "kind"],
          catchphrases: ["Let's find out!", "One step at a time."],
          speakingStyle: "excitable, asks lots of questions",
          relationships: { bea: "best friend" },
        },
        createdAt: now,
      },
      [beeId]: {
        id: beeId,
        name: "Bea",
        voiceId: beaVoice,
        appearance: {
          species: "honeybee",
          ageDescription: "young",
          build: "tiny and rounded",
          face: "cheerful with big friendly eyes",
          hair: "fuzzy black-and-gold striped body",
          eyes: "large sparkling black eyes",
          outfit: "translucent lacy wings",
          accessories: ["yellow flight goggles"],
          palette: ["#F4C430", "#2B2B2B"],
        },
        personality: {
          traits: ["clever", "cautious", "loyal"],
          catchphrases: ["Let me think...", "Buzz-tastic!"],
          speakingStyle: "quick and thoughtful",
          relationships: { milo: "best friend" },
        },
        createdAt: now,
      },
    },
    voices: {
      [miloVoice]: {
        id: miloVoice,
        label: "Milo — warm young narrator",
        providerVoiceRef: "voice:warm-child-male-01",
        language: "en-US",
        accent: "neutral",
        pitch: 3,
        speed: 1.05,
        energy: 0.8,
        emotions: ["excited", "neutral", "curious", "proud"],
      },
      [beaVoice]: {
        id: beaVoice,
        label: "Bea — bright quick",
        providerVoiceRef: "voice:bright-child-female-02",
        language: "en-US",
        accent: "neutral",
        pitch: 5,
        speed: 1.1,
        energy: 0.85,
        emotions: ["thoughtful", "neutral", "delighted"],
      },
    },
    environments: {
      [treehouse]: {
        id: treehouse,
        name: "Treehouse",
        description: "cozy treehouse interior full of maps and jars",
        lighting: "warm golden-hour rim light through a round window",
        props: ["acorn lantern", "rope ladder", "wall of hand-drawn maps"],
        materials: ["worn oak planks", "woven grass rug"],
        mood: "safe, adventurous, warm",
        cameraLanguage: "eye-level medium shots, gentle handheld",
        timeOfDay: "golden hour",
        weather: "clear",
      },
      [meadow]: {
        id: meadow,
        name: "Sunny Meadow",
        description: "wide flowering meadow with a wobbly log bridge over a brook",
        lighting: "soft midday sun, bright and even",
        props: ["log bridge", "clusters of daisies", "babbling brook"],
        materials: ["dewy grass", "mossy logs"],
        mood: "open, cheerful, a little exciting",
        cameraLanguage: "wide establishing shots, slow push-ins",
        timeOfDay: "midday",
        weather: "clear with a gentle breeze",
      },
    },
    episodes: [],
  };
}
