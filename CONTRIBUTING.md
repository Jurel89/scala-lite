## Contributing

Thanks for helping improve Scala Lite.

## Prerequisites

- Node.js 20+
- npm 10+
- (Optional) Rust toolchain if you work on the native engine

## Local Setup

```bash
npm ci
npm run compile
npm test
```

Common commands:

- `npm run typecheck`
- `npm run lint`
- `npm run native:build`
- `npm run native:test`

## Project Structure

- `src/` — VS Code extension implementation
- `src/test/` — extension tests (`node --test`)
- `native/scala-lite-engine/` — Rust engine
- `schema/` — `.vscode/scala-lite.json` JSON schema

## Pull Requests

- Keep changes focused and scoped to a single concern.
- Prefer maintaining Scala Lite’s "performance-first" guardrails (budgets, cancellation, explicit scopes).
- Ensure CI is green:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - (If relevant) `npm run native:test`

## Changelog

- If your PR changes user-visible behavior, add an entry under `## [Unreleased]` in `CHANGELOG.md`.
- Use Keep a Changelog categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Entry format should be one line:
  - `- Brief description (#123)`
  - `- Brief description (FR-0032)`
- Internal-only refactors, CI-only changes, and test-only changes usually do not need changelog entries.

## Reporting Bugs

If you’re reporting a bug or performance issue, please run:

- Scala Lite: Copy Diagnostic Bundle
- Scala Lite: Run Activation Audit
- Scala Lite: Run Idle CPU Audit (30s)

…and include the outputs in the issue.
