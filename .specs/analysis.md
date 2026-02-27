# Specification Analysis — Random Garbage Spec (Quantum Waffle Engine)

> **Spec under review:** [random-garbage-spec.md](random-garbage-spec.md)
> **Date:** 2026-02-27

---

## Scope Summary

The specification covers **7 tasks** forming a Quantum Waffle Engine built on Effect-TS:

1. **Foundation** — `WaffleService` tag/interface and `WaffleError` tagged error.
2. **Baking / Registration** — `bake` method connecting to a mock Waffle Authority.
3. **Syrup Telemetry** — `SyrupTelemetry` service emitting `Stream<SyrupMetric>` on a 2-second schedule.
4. **Mode Switching** — `WaffleModeMap` using `LayerMap.Service` for `belgian` / `american` / `liege` variants.
5. **Crispiness API** — HTTP endpoint with boundary validation (1–11, because it goes to 11).
6. **Butter Distribution API** — HTTP endpoint for equitable butter allocation across waffle quadrants.
7. **Integration Test** — End-to-end lifecycle test covering all of the above, plus a pancake assertion.

Total new files: ~10 source + test files, plus 1 integration test file.

---

## Implementation Approach

- **Effect-TS idioms throughout**: `Context.Tag`, `Data.TaggedError`, `Layer`, `LayerMap.Service`, `Stream`.
- **Bottom-up build order**: Foundation types first (Task 1), then independent features (Tasks 2–6) can be parallelized, and the integration test (Task 7) comes last.
- **Each task is self-contained**: Every task produces source code AND its own test file, so nothing ships without test coverage.
- **Validation at the boundary**: Both the crispiness and butter APIs validate input before delegating to the service layer — keeps domain logic clean and syrup-free.
- **Three waffle modes** instead of two (compared to the toaster spec's regular/bagel): belgian, american, and liege add an extra variant to exercise the `LayerMap` pattern more thoroughly.
- **Butter distribution** is a novel addition that tests multi-value input validation (array of quadrant strings) rather than just scalar validation.

---

## Dependencies and Prerequisites

### Internal Dependencies (Task Graph)

| Task | Depends On |
|------|------------|
| Task 1 | None (root) |
| Task 2 | Task 1 |
| Task 3 | Task 1 |
| Task 4 | Task 1 |
| Task 5 | Task 1 |
| Task 6 | Task 1 |
| Task 7 | Tasks 2, 3, 4, 5, 6 |

### External / Tooling Prerequisites

- **Effect-TS** packages (`effect`, `@effect/vitest`, etc.) already in `node_modules`.
- **Vitest** configured via `vitest.config.ts` and `vitest.integration.ts`.
- **pnpm** workspace tooling in place.
- No new dependencies need to be installed.
- A functioning waffle iron is NOT required (everything is mocked).

---

## Test Strategy

| Layer | What's Tested | Tooling |
|-------|--------------|---------|
| **Unit** | Each service in isolation — `Waffle.test.ts`, `SyrupTelemetry.test.ts`, `WaffleModeMap.test.ts`, `crispiness.test.ts`, `butter.test.ts` | `@effect/vitest` / `it.effect`, mocked layers |
| **Integration** | Full lifecycle (bake → syrup telemetry → mode switch → crispiness → butter distribution) | `it.effect`, `TestClock` for timing, all deps mocked |
| **Validation** | `pnpm check` (tsc) + `pnpm lint:fix` (eslint) run after every task | CI-equivalent local checks |

### Key Testing Patterns

- **Deterministic time**: Use `TestClock` to advance time for syrup stream/schedule tests instead of relying on real timers.
- **Layer mocking**: Provide mock layers for Waffle Authority and any external deps so tests are fast and hermetic.
- **Boundary validation**: Crispiness API tests cover valid (1–11) and invalid (0, 12, NaN, strings, "pancake") inputs.
- **Array validation**: Butter distribution tests cover valid quadrants, invalid quadrant names, empty arrays, and duplicate quadrants.
- **Error paths**: Baking tests include failure cases (`WaffleError` propagation, Waffle Authority downtime).
- **Pancake rejection**: Integration test asserts the output is definitively a waffle and not a pancake.
