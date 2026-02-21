## Scala Lite

[![CI](https://github.com/Jurel89/scala-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/Jurel89/scala-lite/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Jurel89/scala-lite/actions/workflows/codeql.yml/badge.svg)](https://github.com/Jurel89/scala-lite/actions/workflows/codeql.yml)
![License](https://img.shields.io/badge/license-MIT-informational)
<!-- TODO: add VS Code Marketplace badge once published -->

Scala Lite is a **performance-first Scala workflow extension** for VS Code.

It’s for people who want a fast, predictable editing experience plus practical run/test tooling — without turning VS Code into a full semantic Scala IDE.

### What This Is

- A lightweight Scala workflow extension
- Fast syntax features (highlighting, outline)
- Run/Test/Debug helpers that integrate with common Scala build tools
- Best-effort navigation (go-to-definition, find usages) with clear “approximate” labeling
- A small “governor” status bar showing Index/Diagnostics/Build integration state

### What This Is NOT

- Not Metals
- Not an LSP + compiler-backed semantic engine
- No type errors / implicit resolution / semantic highlighting
- No whole-workspace semantic indexing on activation
- No BSP/Bloop required

## Modes (Performance Gearbox)

Scala Lite uses three modes. You can switch modes via Command Palette or the status bar.

| Mode | Name | Indexing | Best For | Cost |
| ---- | ---- | -------- | -------- | ---- |
| A | Editing-only | Off | Reading/editing Scala with minimal overhead | Lowest |
| B | Run/Test | Open files | Running and testing with build integration | Medium (on-demand) |
| C | Indexed module | Selected module folder | Faster symbol workflows within one module | Highest (during indexing) |

Notes:

- **Document outline** is available in all modes.
- **Go to Definition** and **Workspace Symbol Search** are available in Modes B/C.
- **Find Usages** is available in all modes (scoped, best-effort).

## Quick Start

1. Install the extension (Marketplace link coming soon).
2. Open a workspace with Scala files.
3. Run **Scala Lite: Open Configuration** to open `.vscode/scala-lite.json`.
4. If you plan to use Mode C, set `moduleFolder` to your module root.

## Key Commands

All commands live under the **Scala Lite** category:

- Scala Lite: Open Configuration
- Scala Lite: Switch to Mode A / Switch to Mode B / Switch to Mode C
- Scala Lite: Re-detect Build Tool
- Scala Lite: Run Main Entry / Debug Main Entry / Generate Debug Configuration
- Scala Lite: Run Test Suite / Run Test Case
- Scala Lite: Rebuild Index
- Scala Lite: Workspace Doctor
- Scala Lite: Restart Native Engine
- Scala Lite: Run Activation Audit
- Scala Lite: Run Memory Budget Audit
- Scala Lite: Run Idle CPU Audit (30s)
- Scala Lite: Copy Diagnostic Bundle

## Configuration

Scala Lite reads workspace configuration from `.vscode/scala-lite.json`.

VS Code validates the file using the JSON schema in [schema/scala-lite.schema.json](schema/scala-lite.schema.json).

### Example `.vscode/scala-lite.json`

VS Code tolerates comments in JSON for configuration files. If you prefer strict JSON, remove the comment lines.

```jsonc
{
	// Default mode on startup (A/B/C)
	"mode": "A",

	// Required for Mode C indexing. Relative to your workspace root.
	"moduleFolder": "",

	// Task profiles used by Run/Test commands.
	"profiles": [
		{
			"name": "default",
			"buildTool": "sbt",
			"workingDirectory": ".",
			"runCommand": "sbt run",
			"testCommand": "sbt test",
			"envVars": {},
			"jvmOpts": [],
			"preBuildCommand": ""
		}
	],

	// Optional: choose which profile is active by default.
	"activeProfile": "default",

	// Ignore patterns are merged with built-in safety ignores.
	"ignorePatterns": [],
	"unsafeMode": false,

	// Budgets are guardrails for CPU/time and result sizes.
	"budgets": {
		"searchTimeMs": 2000,
		"indexTimeMs": 5000,
		"maxSearchResults": 500,
		"formatterTimeMs": 5000
	},

	"diagnostics": {
		"enabled": true,
		"trigger": "onSave"
	},

	"formatter": {
		"scalafmtPath": "",
		"useDocker": false,
		"timeoutMs": 5000,
		"formatOnSave": false
	},

	"linter": {
		"scalafixPath": "",
		"useDocker": false,
		"timeoutMs": 10000
	},

	"workspaceDoctor": {
		"autoRunOnOpen": false
	},

	"logLevel": "INFO",
	"testFrameworkHints": []
}
```

### Settings UI + workspace file

You can set common options in VS Code Settings UI (`scalaLite.*`) and advanced
options in `.vscode/scala-lite.json`.

When both are present, **workspace file values take precedence**.

## Performance Philosophy

- **Do nothing by default**: no whole-workspace indexing on activation.
- **Do more only when requested**: Mode B/C enable more workflows.
- **Budget everything**: timeouts and max-result caps prevent runaway scans.
- **Cancelability first**: long operations should respect cancellation.

## Troubleshooting

### “Native engine” vs fallback

Scala Lite attempts to load a native engine (Rust) when available. If it cannot, it uses a TypeScript fallback engine.

- Run **Scala Lite: Restart Native Engine** after upgrading/reinstalling.
- Run **Scala Lite: Copy Diagnostic Bundle** and attach the ZIP to an issue.

### “No build tool detected”

- Run **Scala Lite: Re-detect Build Tool**.
- Confirm your workspace root contains `build.sbt`, `build.sc`, or Scala CLI directives.

### Slow searches / too many results

- Prefer narrower scopes (current file/folder/module).
- Tune `budgets.searchTimeMs`, `budgets.maxSearchResults`, and `ignorePatterns`.
- Run **Scala Lite: Workspace Doctor** to spot repo hot-spots (`target/`, generated sources, etc.).

### Activation concerns

- Run **Scala Lite: Run Activation Audit**.
- Run **Scala Lite: Run Idle CPU Audit (30s)** with the workspace idle.

### Workspace Doctor auto-run

Workspace Doctor is user-triggered by default. You can opt in with
`workspaceDoctor.autoRunOnOpen: true` in `.vscode/scala-lite.json`.

When enabled, auto-run starts after a 30-second delay and is skipped for very
large workspaces.

## Development

### Prerequisites

- Node.js 20+
- npm 10+
- (Optional) Rust toolchain for native engine work

### Local commands

```bash
npm ci
npm run compile
npm test
```

- `npm run typecheck` — TypeScript checks
- `npm run lint` — ESLint
- `npm run native:build` — build native Rust engine (release)
- `npm run native:test` — run native Rust tests

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Project Policies

- [CHANGELOG.md](CHANGELOG.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

MIT (see `LICENSE`).

<!-- TODO: add screenshots/GIFs (run/test codelens, status bar governor, workspace doctor output) -->

