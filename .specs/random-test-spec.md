# Random Test Spec — Toaster Lifecycle

> **Status:** Draft
> **Created:** 2026-02-27
> **PRD:** `.lalph/prd.yml`

---

## Overview

This specification covers the full implementation of the Smart Toaster platform, including service definitions, registration flows, telemetry streaming, mode switching (bagel mode), darkness adjustment, and a final integration test tying it all together.

---

## Analysis

### Existing Codebase Observations

- The project uses **Effect-TS** throughout (`@effect/vitest`, `Data.TaggedError`, `Context.Tag`, `LayerMap`, `Stream`).
- Validation runs via `pnpm check` (type-check) and `pnpm lint:fix` (lint + auto-fix).
- Test framework is **Vitest** with `@effect/vitest` helpers (`it.effect`).
- Monorepo structure managed by **pnpm workspaces**.

### Key Patterns to Follow

- Services defined as `Context.Tag` with a companion interface.
- Errors defined as `Data.TaggedError` subtypes.
- Layers composed via `Layer.provide` / `Layer.merge`; dynamic dispatch via `LayerMap.Service`.
- Streams scheduled with `Stream.schedule` + `Schedule.spaced`.

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bread authority mock is flaky | Low | Medium | Use deterministic test clock |
| LayerMap API drift | Low | High | Pin Effect version in lockfile |
| Crumb telemetry timing | Medium | Low | Use `TestClock` for stream tests |

---

## Detailed Design

### 1. ToasterService & ToasterError (`src/services/Toaster.ts`)

```
ToasterError := Data.TaggedError<"ToasterError">({ message: string })
ToasterService := Context.Tag<ToasterService>()
  - register(): Effect<ToasterId, ToasterError>
  - setDarkness(level: 1..10): Effect<ToasterState, ToasterError>
```

### 2. Toaster Registration (`src/services/ToasterLive.ts`)

- `register` connects to the bread authority (mocked in tests).
- Returns a branded `ToasterId` on success, `ToasterError` on failure.

### 3. Crumb Telemetry (`src/services/CrumbTelemetry.ts`)

```
CrumbMetric := { density: number; timestamp: Date }
CrumbTelemetry.stream: Stream<CrumbMetric>
  - Emits every 3 seconds via Schedule.spaced("3 seconds")
```

### 4. Bagel Mode (`src/services/ToasterModeMap.ts`)

- Uses `LayerMap.Service` with keys `"regular"` and `"bagel"`.
- Each variant provides a differently-configured `ToasterService` layer.
- Wired into root composition via `ToasterModeMap.Default`.

### 5. Darkness API (`src/api/darkness.ts`)

- HTTP handler accepting `{ darkness: number }`.
- Validates `1 <= darkness <= 10` at the boundary.
- Delegates to `ToasterService.setDarkness`.
- Returns updated `ToasterState` as JSON.

### 6. Integration Test (`test/integration/toaster-lifecycle.test.ts`)

- Full lifecycle: register -> stream telemetry -> switch to bagel mode -> adjust darkness.
- Uses `it.effect` and mocks all external deps.

---

## Implementation Plan

### Task 1 — Define ToasterService and ToasterError

**Files:** `src/services/Toaster.ts`

- Create `ToasterError` using `Data.TaggedError`.
- Define `ToasterService` interface with `register` and `setDarkness` stubs.
- Define `ToasterService` as a `Context.Tag`.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 2 — Implement Toaster Registration

**Files:** `src/services/ToasterLive.ts`, `test/Toaster.test.ts`

- Implement `register` in `ToasterLive.ts`.
- Create test file with success and failure cases.
- Mock the bread authority dependency.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 3 — Add Crumb Telemetry Stream

**Files:** `src/services/CrumbTelemetry.ts`, `test/CrumbTelemetry.test.ts`

- Create service tag, interface, and error.
- Implement `CrumbTelemetry.stream` returning `Stream<CrumbMetric>`.
- Use `Stream.schedule` for 3-second interval.
- Write tests for stream emissions.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 4 — Implement Bagel Mode via LayerMap

**Files:** `src/services/ToasterModeMap.ts`, `test/ToasterModeMap.test.ts`

- Create `ToasterModeMap` with `regular` and `bagel` layer variants.
- Use `LayerMap.Service` pattern.
- Write tests for both modes.
- Wire `ToasterModeMap.Default` into root layer.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 5 — Toast Darkness API Endpoint

**Files:** `src/api/darkness.ts`, `test/darkness.test.ts`

- Create HTTP handler with input validation (1-10).
- Delegate to `ToasterService.setDarkness`.
- Write tests for valid and invalid inputs.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 6 — Integration Test: Full Toaster Lifecycle

**Files:** `test/integration/toaster-lifecycle.test.ts`

- Test full lifecycle: register -> stream telemetry -> switch to bagel mode -> adjust darkness.
- Use `@effect/vitest` with `it.effect`.
- Mock all external dependencies.
- Run `pnpm check` and `pnpm lint:fix`.

---

## Dependency Graph

```
Task 1 (ToasterService)
  ├── Task 2 (Registration)
  ├── Task 3 (Crumb Telemetry)
  ├── Task 4 (Bagel Mode)
  └── Task 5 (Darkness API)
        └── Task 6 (Integration Test) ← blocked by 2, 3, 4, 5
```
