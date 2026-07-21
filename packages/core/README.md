# @acf/core — Memory-Driven Episode Kernel (Module 1)

The kernel behind **"Create Episode 248."** — the platform loads everything it already
knows about a channel (cast, voices, locations, style, format, performance) and turns one
sentence into a fully-planned episode with every prompt composed from memory.

This is **Module 1** of the AI Content Factory. It is intentionally narrow and **fully
functional** — no placeholder bodies. It runs with **zero dependencies** on Node ≥ 22.18
(uses native TypeScript execution and the built-in test runner).

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

## Test & typecheck

```bash
node --test --experimental-strip-types    # 16 tests, zero deps
npm i && npm run typecheck                 # strict TS (TS 5.8, all strict flags on)
```

## What it actually does

| Concern | Where | Guarantee |
| --- | --- | --- |
| Persistent channel memory | `memory/json-memory-store.ts` | Atomic JSON persistence, survives runs |
| Character identity locking | `prompt/identity.ts` | Deterministic seed + canonical description injected into **every** visual prompt — same in Ep 1 and Ep 248 |
| Voice locking | `domain/voice.ts`, `PromptComposer.voicePrompts` | Same voice ref/pitch/speed resolved every episode |
| Scene memory | `domain/environment.ts`, `PromptComposer.imagePrompt` | Recurring locations keep lighting, props, camera language |
| Vendor independence | `providers/provider.ts` | Orchestrator depends only on capability interfaces; providers are adapters |
| Episode planning | `orchestrator/orchestrator.ts` | Auto-increments episode number, threads the previous episode, records every prompt/output |

## Real providers (Module 2)

By default every capability uses the free offline `LocalProvider`. Set the env vars below to
route a capability to a real model — anything unset stays free/offline. Check what's wired:

```bash
node src/cli.ts providers                         # shows text/image/audio/video → provider ($$ or free)
node src/cli.ts create tiny-explorers --local     # force free/offline regardless of env
```

| Capability | Env vars | Provider |
| --- | --- | --- |
| Text | `OPENAI_API_KEY` (`OPENAI_BASE_URL`, `ACF_TEXT_MODEL`) | OpenAI-compatible chat (Azure/Together/Groq/…) |
| Image | `OPENAI_API_KEY` (`ACF_IMAGE_MODEL`) | OpenAI Images → bytes stored via `ObjectStore` |
| Audio | `ELEVENLABS_API_KEY` (`ACF_TTS_MODEL`) | ElevenLabs TTS (locked voice id per character) |
| Video | `ACF_VIDEO_API_KEY` + `ACF_VIDEO_SUBMIT_URL` + `ACF_VIDEO_STATUS_URL` | Async submit→poll (Veo/Runway/Kling/Genmax shape) |

> ⚠️ **Real providers cost money per generation.** The `LocalProvider` is free only because it
> emits placeholder URIs, not real media. The `providers` command marks billable capabilities.

The orchestrator is **unchanged** between offline and real runs — only the registry wiring in
`providers/factory.ts` differs.

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
