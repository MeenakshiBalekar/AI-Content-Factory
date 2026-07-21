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

## 1. Product thesis

The differentiator is **memory**, not raw generation. Anyone can call an image model. The
moat is that the platform *remembers* a channel so completely that `Create Episode 248`
needs almost no input: it already knows every character's appearance and voice, every
recurring location, the animation style, the intro/outro, the music, the thumbnail style,
the subtitle format, the best-performing hooks, and the publishing schedule.

Everything below serves that thesis. The kernel that makes it true is Module 1.

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

## 4. Provider system

Every vendor is an adapter behind a capability interface. The orchestrator depends only on
the interface; `ProviderRegistry` resolves capability → concrete provider and is the future
home of routing policy.

- **Text**: OpenAI, Anthropic (Claude), Gemini, Genmax `generate_text`.
- **Image**: FLUX, Seedream, Nano Banana (Genmax `generate_image`), Replicate, Fal.
- **Audio/Voice**: ElevenLabs, Cartesia, PlayHT, Genmax `generate_audio`; Music: Suno, Udio.
- **Video**: Runway, Kling, Veo, Pika, Luma, Hailuo, Genmax `generate_video`.
- **Assembly/storage**: FFmpeg, Remotion, Cloudinary, S3-compatible.

Adapter contract: pure translation between our request/response types and the vendor SDK,
plus a `name`, health check, and cost/latency metadata. No business logic in adapters.

> **Session note:** the Genmax MCP tools (`generate_text/image/audio/video`) are live to the
> agent and were used to validate that the composed prompts drive real generation. A Node
> process cannot call MCP tools directly, so a production Genmax adapter is HTTP-based; the
> interface it implements is already defined in `providers/provider.ts`.

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

## 7. Quality engine (roadmap, Module 4)

Subscribes to `stage.succeeded`, inspects each asset, and can reject → regenerate:
character-consistency check (compare against `identityFragment` / reference), blur/framing,
lip-sync alignment, subtitle accuracy, audio quality, hook strength, safety/copyright. On
rejection it re-enqueues the stage with an adjusted prompt or a different provider tier.

---

## 8. Analytics & the learning loop (roadmap, Module 6)

Ingests CTR, watch time, AVD, retention, revenue per platform, writes back into
`ChannelPerformance.bestHooks` and pacing notes — which the `StoryPlanner`/orchestrator
already read. The loop is closed by design: performance is memory, and memory drives the
next episode.

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
