# AI Content Factory

> **The Operating System for AI Content Creation.**

Generate an entire channel from natural language. The platform remembers a channel so
completely — every character's appearance and voice, every recurring location, the
animation style, intro/outro, music, thumbnail style, subtitle format, best hooks, and
publishing schedule — that **"Create Episode 248."** runs with almost no additional input.

## Status

This repository is being built **design-first, one module at a time**. Every merged module
runs and is tested — no placeholder skeletons.

- 📐 **[Technical Design Document](docs/ai-content-factory/TECHNICAL-DESIGN.md)** — target
  architecture, data model, provider/plugin/event design (with an honest scope framing).
- 🗺️ **[Module Roadmap](docs/ai-content-factory/MODULE-ROADMAP.md)** — the build sequence.
- ✅ **[Module 1 — Episode Kernel](packages/core)** — built, 16 tests passing.

## Quick start (Module 1)

Requires **Node ≥ 22.18** (native TypeScript execution). No install needed to run it.

```bash
cd packages/core

node src/cli.ts seed --dir ./.acf-memory
node src/cli.ts create tiny-explorers --dir ./.acf-memory --number 248 --brief "learning to share"
node src/cli.ts memory tiny-explorers --dir ./.acf-memory

node --test --experimental-strip-types    # run the test suite
```

## Why memory is the moat

Anyone can call an image model. The differentiator is that the platform *remembers*, and
that memory is deterministically injected into every generation so a character is identical
in Episode 1 and Episode 248. See
[identity locking](docs/ai-content-factory/TECHNICAL-DESIGN.md#31-identity-locking-the-core-invariant).

## Layout

```
docs/ai-content-factory/   Technical design + roadmap
packages/core/             Module 1 — memory-driven episode kernel (@acf/core)
```

Future modules (real provider adapters, Postgres + API surface, quality engine, workflow
engine, publishing + analytics, multi-agent orchestrator) land as additional `packages/*`
and `apps/*` — see the roadmap.
