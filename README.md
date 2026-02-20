## Scala Lite

Performance-first Scala workflow extension for Visual Studio Code.

## Prerequisites

- Node.js 20+
- npm 10+
- (Optional) Rust toolchain for native engine work

## Quick Start

```bash
npm ci
npm run compile
npm test
```

## Development Commands

- `npm run typecheck` — run TypeScript checks
- `npm run lint` — run ESLint
- `npm test` — compile and execute extension tests
- `npm run native:build` — build native Rust engine (release)
- `npm run native:test` — run native Rust tests

## Repository Layout

- `src/` — extension source code and feature modules
- `src/test/` — functional, integration, and performance tests
- `native/scala-lite-engine/` — Rust native indexing/runtime engine
- `schema/` — workspace configuration schema
- `.github/workflows/` — CI and CodeQL workflows

