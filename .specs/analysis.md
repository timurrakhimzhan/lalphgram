# Specification Analysis — Random Test Spec

> **Spec under review:** [random-test-spec.md](random-test-spec.md)
> **Date:** 2026-02-27

---

## Scope Summary

The specification covers **6 tasks** forming a Smart Toaster platform built on Effect-TS:

1. **Foundation** — `ToasterService` tag/interface and `ToasterError` tagged error.
2. **Registration** — `register` method connecting to a mock bread authority.
3. **Telemetry** — `CrumbTelemetry` service emitting `Stream<CrumbMetric>` on a 3-second schedule.
4. **Mode Switching** — `ToasterModeMap` using `LayerMap.Service` for `regular` / `bagel` variants.
5. **HTTP Endpoint** — Darkness adjustment API with boundary validation (1–10).
6. **Integration Test** — End-to-end lifecycle test covering all of the above.

Total new files: ~8 source + test files, plus 1 integration test file.

---

## Implementation Approach

- **Effect-TS idioms throughout**: `Context.Tag`, `Data.TaggedError`, `Layer`, `LayerMap.Service`, `Stream`.
- **Bottom-up build order**: Foundation types first (Task 1), then independent features (Tasks 2–5) can be parallelized, and the integration test (Task 6) comes last.
- **Each task is self-contained**: Every task produces source code AND its own test file, so nothing ships without test coverage.
- **Validation at the boundary**: The darkness API validates input before delegating to the service layer — keeps domain logic clean.

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
| Task 6 | Tasks 2, 3, 4, 5 |

### External / Tooling Prerequisites

- **Effect-TS** packages (`effect`, `@effect/vitest`, etc.) already in `node_modules`.
- **Vitest** configured via `vitest.config.ts` and `vitest.integration.ts`.
- **pnpm** workspace tooling in place.
- No new dependencies need to be installed.

---

## Test Strategy

| Layer | What's Tested | Tooling |
|-------|--------------|---------|
| **Unit** | Each service in isolation — `Toaster.test.ts`, `CrumbTelemetry.test.ts`, `ToasterModeMap.test.ts`, `darkness.test.ts` | `@effect/vitest` / `it.effect`, mocked layers |
| **Integration** | Full lifecycle (register → telemetry → mode switch → darkness) | `it.effect`, `TestClock` for timing, all deps mocked |
| **Validation** | `pnpm check` (tsc) + `pnpm lint:fix` (eslint) run after every task | CI-equivalent local checks |

### Key Testing Patterns

- **Deterministic time**: Use `TestClock` to advance time for stream/schedule tests instead of relying on real timers.
- **Layer mocking**: Provide mock layers for bread authority and any external deps so tests are fast and hermetic.
- **Boundary validation**: Darkness API tests cover both valid (1–10) and invalid (0, 11, NaN, strings) inputs.
- **Error paths**: Registration tests include failure cases (`ToasterError` propagation).
