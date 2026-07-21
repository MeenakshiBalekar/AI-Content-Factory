# AI Content Factory — Module Roadmap

Each module is scoped to be built **for real** — implemented, tested, shipped — before the
next begins. This keeps the codebase honest: every merged module runs.

Legend: ✅ done · 🔜 next · ⬜ planned

---

### ✅ Module 1 — Memory-Driven Episode Kernel  *(built, 16 tests passing)*
`packages/core`. The differentiator: persistent channel memory + identity/voice/scene
locking + an orchestrator that turns `Create Episode N` into a full, memory-composed
production plan. Zero-dependency strict TypeScript.

- Domain: Channel, Character, Voice, Environment, Episode
- `MemoryStore` (Repository pattern) + atomic `JsonMemoryStore`
- Identity locking: deterministic seed + injected identity fragment
- `PromptComposer` (memory → prompts), `StoryPlanner` (memory → beat sheet)
- `ProviderRegistry` + capability interfaces + deterministic `LocalProvider`
- `EpisodeOrchestrator` + CLI (`seed` / `create` / `memory` / `channels`)

---

### ✅ Module 2 — Real Provider Adapters  *(built, 12 new tests — 28 total)*
Real adapters behind the Module 1 capability interfaces, wired with **zero orchestrator
changes** — proving the seam.

- Shared `HttpClient`: per-request timeout (AbortSignal), exponential backoff + jitter on
  429/5xx/network, typed `ProviderError`.
- `OpenAITextProvider` (OpenAI-compatible chat — also Azure/Together/Groq/Fireworks).
- `OpenAIImageProvider` (Images API → base64 → `ObjectStore`, content-addressed by seed).
- `ElevenLabsAudioProvider` (TTS; locked `providerVoiceRef` = voice id, so voices stay
  consistent; pitch/speed/emotion → voice settings).
- `AsyncVideoProvider` (submit→poll "handle" flow used by Veo/Runway/Kling/Genmax).
- `ObjectStore` abstraction + `FileObjectStore` (S3/Backblaze slot in here).
- `buildProviderRegistry` factory: real provider per capability when its keys are present,
  free `LocalProvider` fallback otherwise; `providers` CLI command reports cost ($$ vs free).
- Contract-tested against local mock servers (no paid calls, green in CI).

**Cost note:** real providers cost money per generation; the factory makes it explicit which
capabilities are billable on any given run. See §4 of the design doc.

**Remaining for Module 2.1:** a native Genmax HTTP adapter (needs Genmax's REST spec — its
tools are exposed over MCP today), plus provider health checks and per-call cost metadata.

### ⬜ Module 3 — Persistence + API Surface
`PostgresMemoryStore` (Prisma) behind the same `MemoryStore` interface; object storage for
assets. Fastify REST + MCP server exposing `channel.*` and `episode.create`. Job queue
(BullMQ) so `create` returns a job id and streams stage events.

### ⬜ Module 4 — Quality Engine
Post-stage inspection + reject/regenerate loop: character-consistency, framing, lip-sync,
subtitle accuracy, hook strength, safety. Consistency levels L2–L4 (reference images,
per-character embeddings).

### ⬜ Module 5 — Workflow Engine
User-editable stage DAG over the existing plan model; drag-and-drop UI (Next.js). Templates
and per-channel pipeline overrides.

### ⬜ Module 6 — Publishing + Analytics + Learning Loop
Platform publishing (YouTube/Shorts/TikTok/…), scheduler, analytics ingest, and write-back
into `ChannelPerformance` so hooks/pacing improve automatically.

### ⬜ Module 7 — Multi-Agent Orchestrator
Specialized agents (Creative Director, Script Writer, Storyboard Artist, Voice Director, …)
collaborating over the event bus, replacing the deterministic planner where quality wins.

### ⬜ Module 8 — Identity, Teams, Billing, Marketplace, Plugins
Org/team/roles/permissions, billing/quota, provider & template marketplace, plugin SDK.

---

## Principle

> Build one module at a time, keep the architecture constant, and never merge a module that
> doesn't run. Breadth is a roadmap; depth is what ships.
