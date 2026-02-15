# Notifications Package

## Rules

- All schemas use `Schema.Class` for runtime validation
- Error types use `Data.TaggedError` with `message` and `cause` fields
- Services use `Context.Tag` — methods return `Effect<A, ServiceError, never>`
- Never use `as` type assertions — only `as const` is permitted
- Events use tagged union pattern with `Data.TaggedEnum`
- No side effects in schema or type definitions
- All exports explicit in barrel files
- Always use `@effect/vitest` — import `{ describe, expect, it, vi }` from `"@effect/vitest"`, use `it.effect` to pass the effect directly. Never use `Effect.runPromise` in tests. For tests that use real timers (`Effect.sleep`, polling), use `it.live` instead of `it.effect`

```typescript
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"

describe("MyService", () => {
  it.effect("does something", () =>
    Effect.gen(function* () {
      const service = yield* MyService
      const result = yield* service.doThing()
      expect(result).toBe("expected")
    }).pipe(Effect.provide(TestLayer))
  )
})
```
