# @acf/core — Kernel, Providers, Persistence, API, Quality, Workflows & Learning Loop (Modules 1–6)

The engine behind **"Create Episode 248."** — the platform loads everything it already
knows about a channel (cast, voices, locations, style, format, performance) and turns one
sentence into a fully-planned episode with every prompt composed from memory, every
output quality-inspected, and rejected output regenerated — through a user-definable
workflow DAG.

Modules 1–5 of the AI Content Factory, all **fully functional** — no placeholder bodies.
Runs with **zero runtime dependencies** on Node ≥ 22.18 (native TypeScript execution,
built-in test runner, built-in SQLite).

## Run it

```bash
cd packages/core

# 1. Seed a fully-populated sample channel (cast, voices, environments, brand)
node src/cli.ts seed --dir ./.acf-memory

# 2. "Create Episode 248" — one sentence in, a full production plan out
node src/cli.ts create tiny-explorers --dir ./.acf-memory --number 248 --brief "learning to share"

# 3. Inspect everything the platform remembers
node src/cli.ts memory tiny-explorers --dir ./.acf-memory

# Full episode JSON (every stage, prompt, and asset URI)
node src/cli.ts create tiny-explorers --dir ./.acf-memory --json
```

## Run it as a service (Module 3)

```bash
node src/cli.ts seed --sqlite acf.db          # durable SQL persistence (node:sqlite)
node src/cli.ts serve --sqlite acf.db --port 8787

curl http://127.0.0.1:8787/v1/health
curl -X POST http://127.0.0.1:8787/v1/channels/tiny-explorers/episodes \
     -H 'content-type: application/json' -d '{"number":248,"brief":"learning to share"}'
# -> 202 { "jobId": "...", "poll": "/v1/jobs/..." }
curl http://127.0.0.1:8787/v1/jobs/<jobId>    # state + per-stage progress + episode
curl http://127.0.0.1:8787/v1/channels/tiny-explorers/episodes
```

Episode creation is an **async job** (real renders take minutes): POST returns `202` with a
job id immediately; the job records a progress event per pipeline stage. `--sqlite` swaps
JSON-file memory for SQL tables (episode append = INSERT; UNIQUE per channel+number) behind
the same `MemoryStore` interface — the Postgres migration is a driver swap.

## Test & typecheck

```bash
npm test                                   # 54 tests, zero deps
npm i && npm run typecheck                 # strict TS (TS 5.8, all strict flags on)
```

## What it actually does

| Concern | Where | Guarantee |
| --- | --- | --- |
| Persistent channel memory | `memory/json-memory-store.ts`, `memory/sqlite-memory-store.ts` | Durable persistence (atomic JSON or SQL tables), survives runs |
| Character identity locking | `prompt/identity.ts` | Deterministic seed + canonical description injected into **every** visual prompt — same in Ep 1 and Ep 248 |
| Voice locking | `domain/voice.ts`, `PromptComposer.voicePrompts` | Same voice ref/pitch/speed resolved every episode |
| Scene memory | `domain/environment.ts`, `PromptComposer.imagePrompt` | Recurring locations keep lighting, props, camera language |
| Vendor independence | `providers/provider.ts` | Orchestrator depends only on capability interfaces; providers are adapters |
| Episode planning | `orchestrator/orchestrator.ts` | Auto-increments episode number, threads the previous episode, records every prompt/output |
| Quality gating | `quality/` | Every stage inspected; rejects regenerate (attempt budget); audit persisted on the episode; honest failure — never silently shipped |

## Quality engine (Module 4)

On by default. Each stage's output runs through pluggable inspectors — identity
consistency (locked fragments present in every visual prompt), full SRT validation,
voice/dialogue coverage, output completeness, thumbnail/title checks. Any `reject`
finding triggers regeneration (default budget: 3 attempts); the episode carries the
full report at `episode.quality` (per-stage attempts, findings, pass/fail).

```bash
node src/cli.ts create tiny-explorers                # quality gating on
node src/cli.ts create tiny-explorers --no-quality   # raw pipeline
```

Vision-model inspectors (blur, framing, lip-sync, pixel-level identity comparison) plug
into the same `Inspector` interface in Module 4.1.

## Workflow engine (Module 5)

Pipelines are data: a validated DAG of stages with dependency edges and per-stage params.
The orchestrator executes any workflow in deterministic topological order; invalid
workflows (cycles, unknown kinds, dangling deps) are rejected before anything generates.

```bash
node src/cli.ts workflows                                      # list templates
node src/cli.ts create tiny-explorers --workflow shorts        # 9:16, 45s, no music
curl -X POST .../v1/channels/tiny-explorers/episodes -d '{"workflow":"shorts"}'
```

Built-ins: `standard` (full long-form) and `shorts` (vertical, parameterized aspect +
duration, music stage removed). Channels can persist custom workflows in memory
(`ChannelMemory.workflows`), which shadow built-ins by id; every episode records its
`workflowId`. The future drag-and-drop editor is a UI over these same objects.

## Publishing, analytics & the learning loop (Module 6)

The flywheel: **publish → measure → learn → the next episode is informed.**

```bash
node src/cli.ts publish tiny-explorers 2                       # export package (manifest + srt)
node src/cli.ts metrics tiny-explorers --metrics perf.json     # ingest + run the learning loop
node src/cli.ts insights tiny-explorers                        # what the platform learned
node src/cli.ts schedule tiny-explorers                        # next publish slot from cadence
```

`metrics` ingest correlates performance with the episodes that produced it, ranks by
retention, and writes winning hooks into `ChannelPerformance` — which the story stage reads
when planning the **next** episode (closed loop, tested). Publishing writes a real,
platform-ready package to disk; the scheduler does IANA-timezone + DST math with zero deps.
Real platform upload (YouTube resumable upload) is a future integration gated on credential
management — a free-quota platform API, never a paid AI API.

## Providers — self-hosted first (Module 2, revised)

**The platform never depends on commercial AI APIs.** Every adapter speaks an open protocol
served by your own GPU infrastructure (vLLM/Ollama, LocalAI, Kokoro-FastAPI, our ComfyUI
render queue) — keyless by default. Full stack guide:
[`docs/ai-content-factory/SELF-HOSTED-STACK.md`](../../docs/ai-content-factory/SELF-HOSTED-STACK.md).

```bash
node src/cli.ts providers                         # shows wiring: [self-hosted] / [commercial] / [offline]
node src/cli.ts create tiny-explorers --local     # force free offline placeholders
```

| Capability | Self-hosted env | Serves |
| --- | --- | --- |
| Text | `ACF_TEXT_BASE_URL` (+`ACF_TEXT_MODEL`) | vLLM / Ollama — Llama, Qwen, Mistral |
| Image | `ACF_IMAGE_BASE_URL` (+`ACF_IMAGE_MODEL`) | LocalAI / SD-WebUI — FLUX.1, SDXL |
| Speech | `ACF_SPEECH_BASE_URL` (+`ACF_SPEECH_MODEL`) | Kokoro-FastAPI / Speaches / XTTS |
| Video | `ACF_VIDEO_SUBMIT_URL` + `ACF_VIDEO_STATUS_URL` | Our render queue → ComfyUI (LTX/Wan) |

Commercial keys (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`) remain as explicit legacy
fallbacks through the same interfaces — never required, never preferred over a configured
self-hosted endpoint. Music/lip-sync/transcription are **future-integration interfaces**
(`providers/future-providers.ts`) awaiting a settled open-source serving stack.

The orchestrator is **unchanged** between offline and real runs — only the registry wiring
in `providers/factory.ts` differs.

## Architecture

```
CLI ─▶ EpisodeOrchestrator ─▶ StoryPlanner        (memory ─▶ beat sheet)
                           ─▶ PromptComposer      (memory ─▶ prompts)
                           ─▶ ProviderRegistry ─▶ factory ─▶ {OpenAI, ElevenLabs, AsyncVideo}
                           │                                  └▶ LocalProvider (free fallback)
                           ─▶ MemoryStore         (load channel, append episode)
```

The `LocalProvider` implements every capability deterministically so the whole pipeline
runs offline and tests are reproducible. Swapping in real providers (Genmax, ElevenLabs,
Runway, …) is a one-line change in `cli.ts` — the orchestrator never changes.

See [`../../docs/ai-content-factory/TECHNICAL-DESIGN.md`](../../docs/ai-content-factory/TECHNICAL-DESIGN.md)
for the full platform architecture and [`MODULE-ROADMAP.md`](../../docs/ai-content-factory/MODULE-ROADMAP.md)
for what comes next.
