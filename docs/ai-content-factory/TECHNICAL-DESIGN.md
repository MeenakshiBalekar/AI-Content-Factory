# AI Content Factory — Technical Design Document

> **The Operating System for AI Content Creation.**
> Status: **v0.1 — Design + Module 1 implemented.** This is a living document.

---

## 0. Honest framing (read this first)

The full vision — Story/Script/Image/Video/Voice/Music AI, 100+ provider adapters, a
drag-and-drop workflow engine, a plugin marketplace, a multi-agent orchestrator, and Web +
REST + GraphQL + MCP + SDK + mobile surfaces, plus analytics that learn — is a **multi-year
program for a funded team**, not a single deliverable. Trying to emit all of it at once
produces a convincing skeleton that does not run, which is the opposite of the brief's own
rule ("never generate placeholder code").

So this document does two things:

1. Specifies the **target architecture** for the whole platform, so every future module
   snaps into a consistent design.
2. Defines a **module sequence** where each module is small enough to be built *for real*,
   tested, and shipped before the next one starts.

**Module 1 (the memory-driven episode kernel) is already built and passing tests** in
[`packages/core`](../../packages/core). Everything else in this document is design intent.

---

## 1. Product thesis & the two layers

The platform is **generic**: a user provides any children's rhyme, song, story, or sequence,
and the system produces a complete animated video. There is no hardcoded or required
character — a cast is *generated from the input*. Two cleanly separated layers make this work:

1. **Content Understanding layer** (`content/`) — *what is happening?* The `ContentDirector`
   turns arbitrary text into a `Storyboard`: title, visual style, an invented cast, and a
   scene sequence (lyrics · visual · action · environment · song). It uses a self-hosted text
   model when configured and a deterministic decomposition otherwise, so it always runs.
2. **Media Generation layer** (orchestrator + providers + render) — *how do we turn those
   events into media?* It consumes a storyboard (bridged to a generic channel + beat sheet)
   and knows nothing about any specific character; it generates images/voice/music/subtitles
   per scene and assembles the MP4.

A second, complementary capability is **memory**: a channel can *persist* a cast so a series
stays consistent across episodes (the "Create Episode 248" path, Module 1). Generic
one-off content and persistent series are the same media layer with different front-ends —
the `ContentDirector` for arbitrary input, the `StoryPlanner` for a remembered channel.

---

## 2. Architecture overview

Clean Architecture with Domain-Driven Design. Dependencies point **inward**; the domain
knows nothing about HTTP, databases, or model vendors.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Interface Layer   Web · REST · GraphQL · MCP · CLI · SDK · Webhooks   │
├──────────────────────────────────────────────────────────────────────┤
│  Application Layer   Orchestrator (Creative Director) · Workflow Engine │
│                      · AI Agents · Quality Engine · Publishing Engine   │
├──────────────────────────────────────────────────────────────────────┤
│  Domain Layer   Channel · Character · Voice · Environment · Episode     │
│                 · Asset · Workflow · Identity/Memory rules  (pure)      │
├──────────────────────────────────────────────────────────────────────┤
│  Infrastructure   MemoryStore(Postgres) · ObjectStore(S3) · Queue      │
│                   (BullMQ/Redis) · Provider Adapters · Event Bus        │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Key seams (already expressed in Module 1)

| Seam | Interface | Why it matters |
| --- | --- | --- |
| Persistence | `MemoryStore` | Swap JSON → Postgres/Prisma with no domain change |
| Model vendors | `TextProvider` / `ImageProvider` / `AudioProvider` / `VideoProvider` | No single-vendor dependency; providers are plug-ins |
| Routing | `ProviderRegistry` | Where the Cost-Optimization AI (quality/cost/quota/health routing) plugs in |
| Consistency | `identity.ts` (seed + fragment) | The mechanism that keeps characters identical forever |

---

## 3. Domain model (memory)

The persisted unit is **channel memory** (`ChannelMemory`): one aggregate per channel.

- **Channel** — the "bible": premise, audience, `ChannelStyle`, `ChannelFormat`,
  `ChannelPerformance` (learned signals), `PublishingSchedule`.
- **Character** — `CharacterAppearance` (immutable identity: species, age, build, face,
  hair, eyes, outfit, accessories, palette) + `CharacterPersonality` (traits, catchphrases,
  relationships) + a `voiceId`.
- **VoiceProfile** — provider-agnostic `providerVoiceRef` + pitch/speed/energy/accent +
  emotion presets.
- **Environment** — recurring location: lighting, props, materials, mood, camera language,
  time, weather.
- **Episode** — number, title, logline, `StoryBeat[]`, and `EpisodeAsset[]` (every produced
  asset with the **exact prompt and output URI** — full auditability).

### 3.1 Identity locking (the core invariant)

For each character we derive:

1. **`identitySeed`** = `sha256(channelId · characterId · immutable appearance) → 31-bit int`.
   Passed to diffusion providers to anchor composition run-to-run.
2. **`identityFragment`** — a canonical descriptive sentence built from the locked
   appearance, injected verbatim into every visual prompt for that character.

Both are pure functions of the locked appearance, so they are **identical in Episode 1 and
Episode 248**. That is the whole guarantee, and it is unit-tested.

**Consistency levels** (roadmap): L0 prompt-fragment injection (built) → L1 seed anchoring
(built) → L2 reference-image / image-to-image conditioning (`referenceImageUri` field
exists) → L3 per-character LoRA/embedding → L4 automated QA rejection loop.

---

## 4. Provider system — SELF-HOSTED FIRST (revised)

> **Policy revision:** the platform never depends on commercial AI APIs. Every capability
> is served by open-source foundation models on our own GPU infrastructure; the long-term
> objective is to own 100% of the inference stack. Model choices, serving stacks, and GPU
> sizing: [`SELF-HOSTED-STACK.md`](./SELF-HOSTED-STACK.md).

Every provider is an adapter behind a capability interface, and every adapter speaks an
**open protocol**, not a vendor SDK. The orchestrator depends only on the interfaces;
`ProviderRegistry` resolves capability → concrete provider and remains the routing seam.

- **Text** — `ChatCompletionsTextProvider` → vLLM / Ollama serving Llama 3.x, Qwen 2.5,
  Mistral (`/v1/chat/completions`, keyless).
- **Image** — `ImagesApiImageProvider` → LocalAI / SD-WebUI bridges serving FLUX.1, SDXL,
  SD 3.5 (`/v1/images/generations`, keyless).
- **Speech** — `SpeechApiAudioProvider` → Kokoro-FastAPI / Speaches / LocalAI serving
  Kokoro-82M, Coqui XTTS-v2 (voice cloning), Piper (`/v1/audio/speech`, keyless).
- **Video** — `AsyncVideoProvider` → **our own render queue** (submit → poll protocol) in
  front of ComfyUI workers running LTX-Video, Wan 2.1, HunyuanVideo, CogVideoX.
- **Future integrations** (interfaces fixed in `providers/future-providers.ts`, adapters
  land when the serving stack settles): `MusicGenerationProvider` (MusicGen, Stable Audio
  Open), `LipSyncProvider` (Wav2Lip, LatentSync), `TranscriptionProvider`
  (Whisper/faster-whisper). No commercial API will ever back these interfaces.

Commercial endpoints that speak the same open protocols still function through the same
adapters when *explicitly* configured (tagged `[commercial]` in the provider report) — a
legacy escape hatch, never a dependency, never chosen over a configured self-hosted
endpoint.

Owning inference *strengthens* the §3 consistency guarantees: exact sampler/seed control,
per-character LoRAs (consistency level L3) that closed APIs cannot offer, and channel
voices as model files we own rather than vendor voice-ids that can be deprecated.

---

## 5. Workflow engine (roadmap, Module 5)

The default pipeline (`DEFAULT_PRODUCTION_PLAN`) is already data:
`story → script → storyboard → image → voice → music → video → subtitles → thumbnail →
metadata`. The workflow engine generalizes this into a user-editable DAG of typed stages,
each declaring a required capability, executed by the orchestrator. Drag-and-drop is a UI
over the same stage list.

---

## 6. Events, jobs, and scale

- **CQRS-lite**: commands (`CreateEpisode`) mutate memory and emit events; queries read
  projections. Module 1 exposes the command synchronously; production wraps it in a job.
- **Queue**: BullMQ on Redis. Each stage is a job; long video renders poll provider handles.
- **Event bus**: `episode.created`, `stage.succeeded`, `asset.rejected`, `episode.published`
  → analytics, notifications, and the learning loop subscribe.
- **Idempotency**: content-addressed asset URIs (implemented in `LocalProvider`) make
  re-runs cheap and dedupe-able.

---

## 7. Quality engine (Module 4 — built)

Inspects each stage's assets and can reject → regenerate within an attempt budget:
identity-consistency (locked fragment + style present in every visual prompt), completeness,
SRT validity, voice coverage, thumbnail/metadata. Findings + attempts are persisted on the
episode; budget-exhaustion fails honestly (`quality.passed: false`). Vision-model inspectors
(blur, framing, lip-sync) plug into the same `Inspector` interface (Module 4.1).

---

## 8. Analytics & the learning loop (Module 6 — built)

`AnalyticsService.ingest` merges `EpisodeMetrics`, `computeInsights` correlates them with the
episodes that produced them and ranks by retention, and `applyLearnings` writes winning hooks
+ avg-view-duration into `ChannelPerformance`. The orchestrator's story stage reads
`bestHooks` and injects them into the next episode's prompt — **the loop is closed and
tested**: performance is memory, and memory drives the next episode. Publishing
(`ExportPublishTarget`) emits a platform-ready package and records each publication; the
scheduler computes the next slot from the channel cadence (IANA tz + DST, zero deps). Real
platform upload targets (YouTube resumable upload) are a future integration gated on
credential management (Module 8) — a free-quota platform API, never a paid AI API.

---

## 9. Security & tenancy

OAuth/OIDC + JWT; organizations → teams → roles → permissions. Row-level tenant isolation on
channel memory. Provider credentials in a secrets manager, never in memory documents. Audit
log of every command and every asset's prompt (the `EpisodeAsset.prompt` field is the
per-asset audit record). Rate limiting and per-tenant quota at the registry seam.

---

## 10. Deployment

TypeScript monorepo (`packages/*`, later `apps/*`). Docker per service; Compose for local,
Kubernetes-ready manifests + Terraform for cloud. Postgres (memory), Redis (queue), S3
(assets), OpenTelemetry → Prometheus/Grafana, Pino logs. CI: GitHub Actions running
`node --test` + `tsc` (Module 1 is already CI-ready with zero install).

---

## 11. Module sequence

See [`MODULE-ROADMAP.md`](./MODULE-ROADMAP.md). Module 1 is **done**. The recommended next
step is **Module 2 (real provider adapters)** so the exact same orchestrator produces real
media, followed by **Module 3 (persistence + API surface)**.
