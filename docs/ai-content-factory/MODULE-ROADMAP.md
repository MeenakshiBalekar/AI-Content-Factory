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

### ✅ Module 3 — Persistence + API Surface  *(built, 14 new tests — 42 total)*
Durable SQL persistence and a REST API with async jobs, all behind the existing seams —
the orchestrator is still unchanged.

- `SqliteMemoryStore` (Node built-in `node:sqlite`): channels + episodes **tables** (an
  episode append is an INSERT, not a document rewrite), UNIQUE (channel, number),
  transactions, WAL. Same `MemoryStore` interface — the Postgres/Prisma swap is a driver
  change, and this schema mirrors that future layout.
- `JobQueue` abstraction + `InMemoryJobQueue`: submit → run async → progress events →
  settle. This is the seam BullMQ/Redis implements in production.
- REST API (`node:http`, framework-free by design):
  - `GET /v1/health` — provider wiring report
  - `GET /v1/channels` / `GET /v1/channels/{id}` / `GET /v1/channels/{id}/episodes`
  - `POST /v1/channels/{id}/episodes` → **202 { jobId }**, body `{ brief?, number? }`
  - `GET /v1/jobs/{id}` — state, per-stage progress events, episode on success
  - input validation (400), unknown channel/job/route (404), JSON errors throughout
- CLI: `serve --port 8787 [--sqlite acf.db] [--local]`; `--sqlite` works for all commands.
- Verified end-to-end over real HTTP: seed → POST episode 248 → poll job → episode
  persisted in SQLite and listed.

**Remaining for Module 3.1:** Postgres driver (same interface/schema), broker-backed queue,
SSE streaming of job events, MCP server exposing the same operations, auth (Module 8 pulls
some of this forward if the API goes public earlier).

### ✅ Module 4 — Quality Engine  *(built, 12 new tests — 54 total)*
Every stage's output is inspected; rejected output is regenerated within an attempt
budget; the full audit (findings, attempts, pass/fail) is persisted on the episode.

- `Finding`/`StageQuality`/`QualityReport` types; severities: `reject` (blocks →
  regenerate) and `warn` (recorded, doesn't block).
- Pluggable `Inspector` interface + deterministic built-ins:
  - **completeness** — media assets must have output URIs; failed assets reject
  - **identity-consistency** — every visual prompt must contain each beat character's
    locked identity fragment + the channel style; missing = drift = reject
  - **subtitles** — full SRT validation (numbering, timing order, overlap, empty cues,
    max 2 lines, 42-char line length)
  - **voice-coverage** — one voice asset per dialogue line, exactly
  - **metadata** — thumbnail carries the locked thumbnail style; title length warning
- Orchestrator: reject → regenerate loop (`maxAttemptsPerStage`, default 3); attempts +
  final findings attached per stage; honest failure when the budget is exhausted
  (`quality.passed: false` — never silently shipped).
- On by default in CLI (`--no-quality` opts out) and API (`quality: null` opts out);
  job progress events include attempts/rejects.
- Proof it works: a flaky-provider test regenerates and passes on attempt 2; and the
  engine caught a real 46-char subtitle line in our own generator (fixed with proper
  word-wrapping — the catch is in the test suite now).

**Remaining for Module 4.1:** vision-model inspectors (blur, framing, lip-sync,
pixel-level character comparison vs reference images) as additional `Inspector`
plug-ins; prompt-adjustment on retry; consistency levels L2–L4.

### ✅ Module 5 — Workflow Engine  *(built, 10 new tests — 64 total)*
Pipelines as data: a validated DAG of typed stages that the orchestrator executes in
dependency order. This is the model a drag-and-drop editor manipulates — the UI (a later
app) is a view over exactly these objects.

- `WorkflowDefinition` / `WorkflowStage`: stages with explicit `dependsOn` edges and
  per-stage `params` (aspect ratio, duration) that override channel memory.
- Validation: duplicate ids, unknown kinds, unknown/self dependencies, cycle detection
  (Kahn's algorithm); `WorkflowValidationError` lists every problem at once.
- Deterministic topological execution order; `compileWorkflow` → orchestrator stages
  with capabilities resolved from a single kind→capability map.
- Built-in templates: **standard** (full long-form pipeline, now with real dependency
  edges) and **shorts** (9:16, 45-second target, no music stage — proving stage removal
  and parameterization).
- Per-channel custom workflows persist in `ChannelMemory.workflows` and shadow built-ins
  by id; episodes record which workflow produced them (`episode.workflowId`).
- API: `GET /v1/workflows`; `POST .../episodes` accepts `workflow` (400 on unknown or
  invalid). CLI: `workflows` command + `--workflow shorts`.
- Invalid workflows throw before any generation runs (nothing persisted, nothing billed).

**Remaining for Module 5.1:** parallel execution of independent DAG branches, workflow
CRUD endpoints, per-stage provider/model pinning, and the visual editor app.

### ✅ Module 6 — Publishing + Analytics + Learning Loop  *(built, 21 new tests — 85 total)*
The flywheel closed: **publish → measure → learn → write back → the next episode is
informed by what actually performed.**

- **Publishing**: `PublishTarget` interface + `ExportPublishTarget` — writes a real,
  platform-ready package on disk (`manifest.json` + `subtitles.srt`); publication recorded
  in `ChannelMemory.publications`. `YouTube/TikTok` upload targets are the future
  integration (need OAuth/credential mgmt from Module 8) — the free-quota platform APIs,
  never a paid AI API.
- **Scheduler**: cadence parser (`daily HH:MM [tz]`, `weekly DAY HH:MM [tz]`) with real
  IANA-timezone + DST math via `Intl` — zero deps; `nextPublishAt` computes the next slot.
- **Analytics**: `EpisodeMetrics` ingest (source-agnostic: JSON/CSV now, YouTube Analytics
  API later), validation, `mergeMetrics`; `computeInsights` correlates metrics with the
  episodes that produced them and ranks by retention.
- **Learning loop (the point)**: `applyLearnings` writes winning hooks + avg-view-duration
  into `ChannelPerformance`; the orchestrator's story stage reads `bestHooks` and injects
  them into the next episode's prompt. Proven by a test: ingest metrics → the *next*
  episode's story prompt cites the winning hook.
- API: `POST .../metrics`, `GET .../insights`, `POST .../episodes/{n}/publish`,
  `GET .../schedule`. CLI: `metrics`, `insights`, `publish`, `schedule`.

**Remaining for Module 6.1:** real platform upload targets (YouTube resumable upload) once
Identity/credentials (Module 8) exists; A/B thumbnail testing; retention-curve ingestion.

### ⬜ Module 7 — Multi-Agent Orchestrator
Specialized agents (Creative Director, Script Writer, Storyboard Artist, Voice Director, …)
collaborating over the event bus, replacing the deterministic planner where quality wins.

### ⬜ Module 8 — Identity, Teams, Billing, Marketplace, Plugins
Org/team/roles/permissions, billing/quota, provider & template marketplace, plugin SDK.

---

## Principle

> Build one module at a time, keep the architecture constant, and never merge a module that
> doesn't run. Breadth is a roadmap; depth is what ships.
