# ESLint Plugin Package

## Rules

- `no-direct-result-tag` — warns against direct `._tag` access on Result types, use `Result.match` instead
- `prefer-get-result` — use `get.result(dependency)` instead of `get(dependency)` for atoms that return `Result<A, E>` (type-aware, requires `parserOptions.projectService`; silently skips without type info)
- `no-catch-all-recovery` — errors when `catchAll`/`catchAllDefect` is used for recovery logic; only allows it when the handler just logs (`Effect.logError`)
- `no-silent-error-catch` — errors when `catchTag`/`catchTags` handlers silently swallow errors without logging; handler must call `Effect.logError`/`logWarning`/`logFatal` or map to another error via `Effect.fail`
- `enforce-service-of-mock` — enforces `Service.of()` for creating typed mocks in tests
- `no-effectful-function` — errors when a module-level function with parameters uses Effect/Layer/Stream/Schedule APIs; effectful logic belongs as service methods or Layer constants. Does NOT flag: Effect/Layer constants without parameters, pure functions, functions nested inside Layer.effect/Layer.succeed/Layer.scoped/Effect.gen bodies, or service method implementations inside `.of({...})`
- `no-direct-result-tag` and `prefer-get-result` are warnings; `no-catch-all-recovery`, `no-silent-error-catch`, `no-effectful-function`, and `enforce-service-of-mock` are errors
