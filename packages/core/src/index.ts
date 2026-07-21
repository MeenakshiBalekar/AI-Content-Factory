// Public API for @acf/core — Module 1: the memory-driven episode kernel.
export * from "./domain/ids.ts";
export type { Channel, ChannelStyle, ChannelFormat, ChannelPerformance, PublishingSchedule } from "./domain/channel.ts";
export type { Character, CharacterAppearance, CharacterPersonality } from "./domain/character.ts";
export type { VoiceProfile } from "./domain/voice.ts";
export { clampVoice, DEFAULT_EMOTION } from "./domain/voice.ts";
export type { Environment } from "./domain/environment.ts";
export type { Episode, EpisodeAsset, StoryBeat, AssetKind, StepStatus } from "./domain/episode.ts";
export { recapOf } from "./domain/episode.ts";

export type { ChannelMemory, MemoryStore } from "./memory/memory-store.ts";
export { UnknownChannelError } from "./memory/memory-store.ts";
export { JsonMemoryStore } from "./memory/json-memory-store.ts";

export { identitySeed, identityFragment, paletteToken } from "./prompt/identity.ts";
export { PromptComposer } from "./prompt/prompt-composer.ts";

export * from "./providers/provider.ts";
export { LocalProvider } from "./providers/local-provider.ts";

export { DEFAULT_PRODUCTION_PLAN } from "./orchestrator/production-plan.ts";
export type { ProductionStage } from "./orchestrator/production-plan.ts";
export { StoryPlanner } from "./orchestrator/story-planner.ts";
export { EpisodeOrchestrator } from "./orchestrator/orchestrator.ts";
export type { CreateEpisodeOptions, StageEvent } from "./orchestrator/orchestrator.ts";
