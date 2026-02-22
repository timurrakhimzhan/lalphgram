# Project Instructions

- **At the start of every task**: before switching branches, ALWAYS commit any uncommitted changes to the current branch (use a `WIP: ...` commit message if needed). NEVER stash or discard changes — always preserve progress with a commit. Then checkout main, pull latest (`git pull --rebase origin main`), and create a new feature branch off it
- **Before pushing or creating a Pull Request**: rebase onto the latest base branch (`git pull --rebase origin <base-branch>`)
- Always run `pnpm check` and `pnpm lint:fix` after every change
- **Before committing**: ALWAYS run `pnpm check`, `pnpm lint:fix`, and `pnpm test` — do NOT commit unless all three pass
- Never use `npx tsc` - always use `pnpm check` instead
- Never use `any` in TypeScript, unless asked
- NEVER use `as` type assertions — only `as const` is permitted. Always rely on type inference
- NEVER use raw Promises — always use `Effect`. When interacting with Promise-based APIs, wrap them with `Effect.tryPromise`

## Reference Documentation

- The `repos/` folder contains cloned source code for reference (e.g. `repos/effect-ts/`). When you need to understand how an Effect-TS API works, look in `repos/effect-ts/` for source code and examples before searching the web

## Feature Building

- After implementing any new behavior, write tests in the corresponding test file (e.g. `src/services/Foo.ts` → `test/Foo.test.ts`). If no test file exists, create one
- Always run `pnpm check` and `pnpm lint:fix` to verify before finishing

## Testing

- **Always use `@effect/vitest`** — import `{ describe, expect, it, vi }` from `"@effect/vitest"`, use `it.effect` to pass the effect directly. Never use `Effect.runPromise` in tests

```typescript
import { describe, expect, it, vi } from "@effect/vitest"

// Always use Service.of() to create typed mocks — never manually type vi.fn()
const dbMock = Database.of({
  findItems: vi.fn(() => Effect.succeed([]))
})
const dbLayer = Layer.succeed(Database, dbMock)

it.effect("creates an item with the given name", () =>
  Effect.gen(function*() {
    // ...
    // Assert on the mock method directly
    expect(dbMock.findItems).toHaveBeenCalled()
    expect(dbMock.findItems).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "test-user" })
    )
  }).pipe(Effect.provide(dbLayer))
)
```

- **Always mock services using `const mockService = Service.of({ method: vi.fn(...) })`** — assert directly on the mock method (`expect(mockService.method).toHaveBeenCalledWith(...)`) — never access `.mockService.calls[0]` or `.mockService.results`
- **Follow AAA (Arrange-Act-Assert)** — every test must have three clearly separated sections, each decorated with a comment:
  - `// Arrange` — set up mocks, layers, initial state
  - `// Act` — run the effect/function under test (exactly once)
  - `// Assert` — verify expectations
  - Never mix Act and Assert — if you need to act, assert, act again, assert again, split into separate test cases
  - Shared Arrange logic goes in `beforeEach` or a helper, not duplicated across tests
- **Always use `vi.fn()` for tracking calls** — never create manual counters, call trackers, or custom functions to count invocations. Use vitest's built-in mock utilities (`vi.fn()`, `toHaveBeenCalledTimes()`, etc.) for all call tracking and assertion needs
- **Test structure** — `describe` names a behavior or capability (`"item creation"`), `it` describes a specific scenario (`"creates an item with the given name"`). Together they read as a sentence: `"item creation → creates an item with the given name"`. Never reference bugs, tickets, or implementation details in test names

## Layer Composition & `Effect.provide`

- **Provide all layer implementations in the root file (Main.ts)** — never provide the same service in multiple places. Providing a layer more than once creates duplicate instances, leading to inconsistent state
- **Never inline `Effect.provide` inside `Effect.gen`** — don't write `yield* someEffect.pipe(Effect.provide(layer))`. Services are accessed via `yield* ServiceTag`, and layers are provided externally
- **The only inline `Effect.provide` in production code is `LayerMap.get()`** — when the layer is selected dynamically at runtime (e.g. `Effect.provide(DataSourceMap.get(key))`). All other dependencies are wired at the root
- **Use `LayerMap.Service` for dynamic layer selection** — when a service implementation is chosen at runtime (e.g. based on config), define a `LayerMap.Service` with a `lookup` function or `layers` record. Use `MyMap.get(key)` with `Effect.provide` — this is the ONE allowed inline provide:

  ```typescript
  class TrackerMap extends LayerMap.Service<TrackerMap>()("TrackerMap", {
    layers: {
      linear: LinearTrackerLive,
      github: GitHubIssueTrackerLive
    }
  }) {}

  // Usage inside Layer.effect: Effect.provide(TrackerMap.get("linear"))
  // Wire TrackerMap.Default in the root layer composition
  ```
- **In tests, compose a `TestLayer` and provide it at the outer pipe** — never inline `Effect.provide` inside the generator body. Build layers in Arrange, provide at the `.pipe(...)` boundary:

```typescript
// GOOD — provide at the pipe boundary
it.effect("does something", () =>
  Effect.gen(function* () {
    const service = yield* MyService
    const result = yield* service.doThing()
    expect(result).toBe("expected")
  }).pipe(Effect.provide(TestLayer))
)

// BAD — never inline provide inside Effect.gen
it.effect("does something", () =>
  Effect.gen(function* () {
    const service = yield* MyService.pipe(Effect.provide(testLayer)) // ❌
    const result = yield* service.doThing().pipe(Effect.provide(depLayer)) // ❌
  })
)
```

## Services

- Define services using `Context.Tag` — every method must return `Effect<A, ServiceError, never>` (requirements always `never`)
- Never add static methods to Effect service tags (beyond `Default` layer) — use standalone functions or service methods instead
- Never pass services as function arguments — always use Effect dependency injection (`yield* ServiceTag`)
- Each service has a dedicated error created with `Data.TaggedError`

```typescript
export class ItemRepositoryError extends Data.TaggedError("ItemRepositoryError")<{
  message: string
  cause: unknown
}> {}

export interface ItemRepositoryService {
  findItems: (userId: string) => Effect.Effect<ReadonlyArray<Item>, ItemRepositoryError>
}

export class ItemRepository extends Context.Tag("ItemRepository")<
  ItemRepository,
  ItemRepositoryService
>() {}
```

## Streams-First Architecture

- **Prefer `Stream` over polling or one-shot effects** for WebSocket connections, subscriptions, and any data that changes over time — Effect's Stream API is powerful and composable
- Use streams for: WebSocket message handling, event subscriptions, state change propagation, real-time data feeds
- Compose streams with `Stream.map`, `Stream.mapEffect`, `Stream.filter`, `Stream.merge`, etc. instead of imperative event listeners

## Error Handling

- Every service has its own dedicated tagged error (e.g. `ItemRepositoryError`, `DatabaseError`)
- Error fields: `message: string`, `cause: unknown` (original error or null)
- The `message` must propagate the original error's message, optionally prefixed with additional context
- The "final catch point" is where an effect is run to completion — e.g. a forked fiber, a stream's `runDrain`, or the program entrypoint. This is where all errors must be caught, logged, and the error channel becomes `never`
- Don't log when mapping to another error — the cause chain preserves context. Only log at the final catch point
- When using `catchTag`/`catchTags`, always log the error — catching without logging silently swallows errors
- Never add `catchTag`/`catchTags` to an effect that has no errors in its error channel — it's unnecessary and misleading
- Avoid `catchAll` for recovery logic — use `catchTag`/`catchTags` instead. `catchAll` is only acceptable when the handler just logs the error
- Add `.pipe(Effect.ensuringErrorType<never>())` at the final catch point — where all errors are caught, logged, and the error channel is `never`
- Use `Effect.annotateLogs` to add context (service, method, userId, etc.) instead of manually prefixing log messages
- When logging errors at the final catch point, use `Effect.annotateLogs` to give richer context (e.g. relevant IDs, operation name, input parameters) for easier future debugging
