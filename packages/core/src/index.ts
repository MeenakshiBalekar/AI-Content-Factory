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
export { SqliteMemoryStore } from "./memory/sqlite-memory-store.ts";

// Module 3 — jobs + API surface.
export { InMemoryJobQueue } from "./jobs/job-queue.ts";
export type { Job, JobEvent, JobQueue, JobState, JobTask } from "./jobs/job-queue.ts";
export { createApiServer, listen } from "./api/server.ts";
export type { ApiDeps } from "./api/server.ts";

export { identitySeed, identityFragment, paletteToken } from "./prompt/identity.ts";
export { PromptComposer } from "./prompt/prompt-composer.ts";

export * from "./providers/provider.ts";
export { LocalProvider } from "./providers/local-provider.ts";

// Module 2 (revised: self-hosted-first) — provider adapters and wiring.
export { HttpClient, ProviderError, DEFAULT_RETRY } from "./providers/http/http-client.ts";
export type { RetryPolicy, HttpRequest, HttpClientOptions } from "./providers/http/http-client.ts";
export { loadProvidersConfig } from "./providers/http/config.ts";
export type {
  ProvidersConfig,
  ProviderMode,
  ChatTextConfig,
  ImageGenConfig,
  SpeechConfig,
  ElevenLabsConfig,
  AsyncVideoConfig,
} from "./providers/http/config.ts";
export { ChatCompletionsTextProvider } from "./providers/chat-completions-text-provider.ts";
export { ImagesApiImageProvider } from "./providers/images-api-image-provider.ts";
export { SpeechApiAudioProvider } from "./providers/speech-api-audio-provider.ts";
export { ElevenLabsAudioProvider } from "./providers/elevenlabs-audio-provider.ts";
export { AsyncVideoProvider } from "./providers/async-video-provider.ts";
export type {
  MusicGenerationProvider,
  LipSyncProvider,
  TranscriptionProvider,
} from "./providers/future-providers.ts";
export { buildProviderRegistry } from "./providers/factory.ts";
export type { BuildOptions, BuildResult, ProviderReport } from "./providers/factory.ts";
export { FileObjectStore } from "./storage/object-store.ts";
export type { ObjectStore } from "./storage/object-store.ts";

export { DEFAULT_PRODUCTION_PLAN } from "./orchestrator/production-plan.ts";
export type { ProductionStage } from "./orchestrator/production-plan.ts";
export { StoryPlanner } from "./orchestrator/story-planner.ts";
export { EpisodeOrchestrator } from "./orchestrator/orchestrator.ts";
export type { CreateEpisodeOptions, OrchestratorOptions, StageEvent } from "./orchestrator/orchestrator.ts";

// Local render pipeline — real MP4 via FFmpeg.
export {
  checkFfmpeg,
  checkFfprobe,
  probeMedia,
  FfmpegError,
  FfmpegNotInstalledError,
  FFMPEG_BIN,
  FFPROBE_BIN,
} from "./render/ffmpeg.ts";
export type { MediaProbe } from "./render/ffmpeg.ts";
export { LocalImageProvider, LocalSpeechProvider, LocalBackendUnavailableError, localBackendConfig } from "./render/local-backends.ts";
export { AssetResolver } from "./render/asset-resolver.ts";
export type { RenderPlan, RenderBeat, ImageSource, AudioSource, MusicSource } from "./render/asset-resolver.ts";
export { FFmpegRenderer } from "./render/ffmpeg-renderer.ts";
export { RenderService } from "./render/render-service.ts";
export type { RenderResult } from "./render/render-service.ts";

// Module 7 — multi-agent orchestrator.
export type { Agent, AgentRole, AgentMessage, AgentContext } from "./agents/agent.ts";
export { parseVerdict, extractField } from "./agents/agent.ts";
export { ROLE_SPECS } from "./agents/roles.ts";
export type { RoleSpec } from "./agents/roles.ts";
export { LlmAgent } from "./agents/llm-agent.ts";
export { CreativeCrew } from "./agents/crew.ts";
export type { CreativeBrief, CrewAgents, CrewOptions } from "./agents/crew.ts";
export { buildCreativeCrew } from "./agents/crew-factory.ts";

// Module 6 — publishing, analytics & the learning loop.
export { ExportPublishTarget } from "./publishing/publish-target.ts";
export type { PublishTarget, PublishRecord, ExportManifest } from "./publishing/publish-target.ts";
export { parseCadence, nextPublishAt, CadenceParseError } from "./publishing/scheduler.ts";
export type { ParsedCadence } from "./publishing/scheduler.ts";
export { PublishingService } from "./publishing/publishing-service.ts";
export { validateMetrics, mergeMetrics } from "./analytics/metrics.ts";
export type { EpisodeMetrics } from "./analytics/metrics.ts";
export { computeInsights, applyLearnings } from "./analytics/insights.ts";
export type { ChannelInsights, EpisodeInsight } from "./analytics/insights.ts";
export { AnalyticsService } from "./analytics/analytics-service.ts";

// Module 5 — workflow engine.
export {
  CAPABILITY_FOR_KIND,
  WorkflowValidationError,
  assertValidWorkflow,
  compileWorkflow,
  topologicalOrder,
  validateWorkflow,
} from "./workflow/workflow.ts";
export type { StageParams, WorkflowDefinition, WorkflowStage } from "./workflow/workflow.ts";
export {
  BUILTIN_WORKFLOWS,
  SHORTS_WORKFLOW,
  STANDARD_WORKFLOW,
  findBuiltinWorkflow,
  resolveWorkflow,
} from "./workflow/builtin-workflows.ts";

// Module 4 — quality engine.
export { QualityEngine } from "./quality/quality-engine.ts";
export {
  CompletenessInspector,
  IdentityConsistencyInspector,
  SubtitleInspector,
  VoiceCoverageInspector,
  MetadataInspector,
  defaultInspectors,
} from "./quality/inspectors.ts";
export type { Inspector, StageContext } from "./quality/inspectors.ts";
export { buildReport, hasRejects } from "./quality/report.ts";
export type { Finding, QualityReport, Severity, StageQuality } from "./quality/report.ts";
