# Lalph Notifier — Monorepo Overview

## Packages

| Package | Path | Purpose |
|---|---|---|
| `@qotaq/lalphgram` | `packages/lalphgram` | Main app — polls GitHub/Linear, sends Telegram notifications, manages plan sessions with Claude. Includes SDK-based claude shim at `src/shim/` |
| `@qotaq/eslint-plugin` | `packages/eslint-plugin` | Custom ESLint rules for Effect-TS patterns |

## Dependency Graph

```
notifications ──depends on──> eslint-plugin (dev, lint only)
```

## Cross-Package: Plan Session File Flow

The spec/analysis file detection pipeline spans three systems:

```
lalph PromptGen (system prompt)
  ↓ tells Claude to write specs to .specs/ and plan.json
notifications/src/shim/ (SDK-based claude binary replacement)
  ↓ streams tool_use blocks with file_path as NDJSON
notifications/PlanSession
  ↓ extracts file_path from Write/Edit/NotebookEdit tool_use blocks
  ↓ classifies: isSpecFile (.specs/* except analysis.md, or plan.json)
  ↓             isAnalysisFile (.specs/analysis.md)
  ↓ emits: PlanSpecCreated / PlanSpecUpdated / PlanAnalysisReady
notifications/EventLoop
  → handles events (Telegram messages, analysis follow-ups)
```

- **lalph** (`repos/lalph/src/PromptGen.ts` → `planPrompt`) — defines the `.specs/` directory and `plan.json` conventions in Claude's system prompt
- **AnalysisPrompts** (`notifications/src/lib/AnalysisPrompts.ts`) — generates follow-up prompts instructing Claude to write `.specs/analysis.md`, sent as `follow_up` messages through the shim
- **shim** (`notifications/src/shim/`) — pure passthrough; streams all SDK messages as NDJSON without inspecting file paths
- **PlanSession** (`notifications/src/services/PlanSession.ts`) — pattern-matches `file_path` from tool_use blocks in the NDJSON stream, classifies into spec vs analysis files, emits typed events
- **EventLoop** (`notifications/src/services/EventLoop.ts`) — reacts to events: sends Telegram notifications, triggers analysis follow-ups on `PlanSpecCreated`/`PlanSpecUpdated`

## Tech Stack

- **Runtime**: Effect-TS (`Context.Tag` services, `Layer` DI, `Stream` events, `Queue` async I/O)
- **CLI**: `@effect/cli` (notifications entry point)
- **APIs**: `octokit` (GitHub), `@linear/sdk` (Linear), `telegraf` (Telegram), `@anthropic-ai/claude-agent-sdk` (Claude)
- **Build**: TypeScript (`tsc -b`), Babel (pure-call annotation, CJS transform), `@effect/build-utils`
- **Test**: Vitest + `@effect/vitest` (`it.effect`, `it.live`)
- **Lint**: ESLint 9 flat config + dprint formatting via `@effect/eslint-plugin`

## Scripts (root)

| Script | What it does |
|---|---|
| `pnpm build` | Build all packages via Effect build-utils |
| `pnpm check` | TypeScript type-check notifications |
| `pnpm lint` | ESLint across all src/test files |
| `pnpm test` | Vitest across all packages |
| `pnpm dev:notifications` | `LOG_LEVEL=DEBUG tsx` for notifications |
| `pnpm clean` | Remove .tsbuildinfo, build/, dist/, coverage/ |

## Pre-commit Hook

`.husky/pre-commit` runs: `pnpm check && pnpm lint-staged && pnpm test --run`

lint-staged runs `eslint --fix` on staged `*.{ts,mjs}` files.

## ESLint Rules (`@qotaq/eslint-plugin`)

| Rule | Severity | Purpose |
|---|---|---|
| `no-catch-all-recovery` | error | `catchAll`/`catchAllDefect` only for `Effect.logError`, not recovery logic |
| `no-silent-error-catch` | error | `catchTag`/`catchTags` must log or re-fail, not swallow silently |
| `no-effectful-function` | error | Module-level parameterized functions can't use Effect/Layer/Stream/Schedule — use services |
| `no-direct-result-tag` | warn | Don't access `result._tag` directly |
| `prefer-get-result` | warn | Prefer `get.result()` over `get()` in Effect atoms |
| `enforce-service-of-mock` | error (tests only) | Use `Service.of({...})` for typed mocks |

`no-effectful-function` is disabled for test files.

## Config Files

- `tsconfig.base.json` — Strict, ES2022, NodeNext, composite, incremental
- `eslint.config.mjs` — Flat config with dprint, import sorting, custom rules
- `vitest.config.ts` — Projects: notifications, eslint-plugin
- `vitest.shared.ts` — Shared: es2020, concurrent, @effect/vitest equality testers
- `pnpm-workspace.yaml` — `packages/*`

## Reference Repos

`scripts/worktree-setup.sh` clones Effect-TS to `repos/effect-ts/` for offline API reference. Gitignored.
