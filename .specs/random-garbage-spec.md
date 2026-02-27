# Random Garbage Spec — Quantum Waffle Engine

> **Status:** Draft
> **Created:** 2026-02-27
> **PRD:** `.lalph/prd.yml`

---

## Overview

This specification covers the construction of a Quantum Waffle Engine capable of entangling breakfast items across parallel dimensions. The engine must support syrup viscosity calibration, multi-threaded butter distribution, and a real-time crispiness oracle.

---

## Analysis

### Existing Codebase Observations

- The project currently has zero waffle-related modules.
- There is an untapped synergy between the toaster platform and waffle technology.
- The `node_modules` folder weighs more than a small planet — no new deps needed.
- Someone left a comment that says `// TODO: waffles?` in line 42 of a file that doesn't exist.

### Key Patterns to Follow

- Services defined as `Context.Tag` with companion interfaces (inherited from toaster lineage).
- Errors defined as `Data.TaggedError` subtypes named after breakfast catastrophes.
- Layers composed via `Layer.provide` / `Layer.merge`; dynamic dispatch via `LayerMap.Service`.
- All waffle streams scheduled with `Stream.schedule` + `Schedule.fibonacci` for maximum chaos.

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Syrup overflow in production | High | Catastrophic | Use `Effect.acquireRelease` for syrup handles |
| Butter distribution deadlock | Medium | High | Implement lock-free butter via `Ref.make` |
| Crispiness oracle returns NaN | Low | Medium | Default to "golden brown" on oracle failure |
| Interdimensional waffle leak | Very Low | Existential | Add a `Scope` around all dimension hops |
| Someone orders pancakes instead | Certain | Emotional | Return `WaffleError("pancakes are not waffles")` |

---

## Detailed Design

### 1. WaffleService & WaffleError (`src/services/Waffle.ts`)

```
WaffleError := Data.TaggedError<"WaffleError">({ message: string, syrupLevel: number })
WaffleService := Context.Tag<WaffleService>()
  - bake(): Effect<WaffleId, WaffleError>
  - setCrispiness(level: 1..11): Effect<WaffleState, WaffleError>
  - distributeButter(quadrants: Quadrant[]): Effect<ButterMap, WaffleError>
```

### 2. Waffle Registration (`src/services/WaffleLive.ts`)

- `bake` connects to the Waffle Authority (a fictional governance body for waffles).
- Returns a branded `WaffleId` on success, `WaffleError` on failure.
- Includes a 50ms artificial delay to simulate batter pouring.

### 3. Syrup Telemetry (`src/services/SyrupTelemetry.ts`)

```
SyrupMetric := { viscosity: number; temperature: number; timestamp: Date }
SyrupTelemetry.stream: Stream<SyrupMetric>
  - Emits every 2 seconds via Schedule.spaced("2 seconds")
  - Viscosity ranges from 1 (water) to 100 (cement)
```

### 4. Waffle Mode Map (`src/services/WaffleModeMap.ts`)

- Uses `LayerMap.Service` with keys `"belgian"`, `"american"`, and `"liege"`.
- Each variant provides a differently-configured `WaffleService` layer.
- Belgian mode enables deep pockets. American mode enables thin crispiness. Liege mode enables pearl sugar.

### 5. Crispiness API (`src/api/crispiness.ts`)

- HTTP handler accepting `{ crispiness: number }`.
- Validates `1 <= crispiness <= 11` (because these go to 11).
- Delegates to `WaffleService.setCrispiness`.
- Returns updated `WaffleState` as JSON.

### 6. Butter Distribution API (`src/api/butter.ts`)

- HTTP handler accepting `{ quadrants: ["NW", "NE", "SW", "SE"] }`.
- Validates quadrant names.
- Delegates to `WaffleService.distributeButter`.
- Returns `ButterMap` showing distribution per quadrant.

### 7. Integration Test (`test/integration/waffle-lifecycle.test.ts`)

- Full lifecycle: bake → stream syrup telemetry → switch to belgian mode → set crispiness to 11 → distribute butter to all quadrants.
- Uses `it.effect` and mocks all external deps.
- Verifies the waffle is not a pancake at the end.

---

## Implementation Plan

### Task 1 — Define WaffleService and WaffleError

**Files:** `src/services/Waffle.ts`

- Create `WaffleError` using `Data.TaggedError`.
- Define `WaffleService` interface with `bake`, `setCrispiness`, and `distributeButter` stubs.
- Define `WaffleService` as a `Context.Tag`.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 2 — Implement Waffle Baking (Registration)

**Files:** `src/services/WaffleLive.ts`, `test/Waffle.test.ts`

- Implement `bake` in `WaffleLive.ts`.
- Create test file with success and failure cases.
- Mock the Waffle Authority dependency.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 3 — Add Syrup Telemetry Stream

**Files:** `src/services/SyrupTelemetry.ts`, `test/SyrupTelemetry.test.ts`

- Create service tag, interface, and error.
- Implement `SyrupTelemetry.stream` returning `Stream<SyrupMetric>`.
- Use `Stream.schedule` for 2-second interval.
- Write tests for stream emissions using `TestClock`.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 4 — Implement Waffle Mode Map

**Files:** `src/services/WaffleModeMap.ts`, `test/WaffleModeMap.test.ts`

- Create `WaffleModeMap` with `belgian`, `american`, and `liege` layer variants.
- Use `LayerMap.Service` pattern.
- Write tests for all three modes.
- Wire `WaffleModeMap.Default` into root layer.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 5 — Crispiness API Endpoint

**Files:** `src/api/crispiness.ts`, `test/crispiness.test.ts`

- Create HTTP handler with input validation (1-11).
- Delegate to `WaffleService.setCrispiness`.
- Write tests for valid and invalid inputs (including the mythical 12).
- Run `pnpm check` and `pnpm lint:fix`.

### Task 6 — Butter Distribution API Endpoint

**Files:** `src/api/butter.ts`, `test/butter.test.ts`

- Create HTTP handler with quadrant validation.
- Delegate to `WaffleService.distributeButter`.
- Write tests for valid quadrants, invalid quadrants, and empty arrays.
- Run `pnpm check` and `pnpm lint:fix`.

### Task 7 — Integration Test: Full Waffle Lifecycle

**Files:** `test/integration/waffle-lifecycle.test.ts`

- Test full lifecycle: bake → stream syrup → switch to belgian mode → crispiness to 11 → butter all quadrants.
- Use `@effect/vitest` with `it.effect`.
- Mock all external dependencies.
- Assert the final waffle is not a pancake.
- Run `pnpm check` and `pnpm lint:fix`.

---

## Dependency Graph

```
Task 1 (WaffleService)
  ├── Task 2 (Baking / Registration)
  ├── Task 3 (Syrup Telemetry)
  ├── Task 4 (Waffle Mode Map)
  ├── Task 5 (Crispiness API)
  └── Task 6 (Butter Distribution API)
        └── Task 7 (Integration Test) ← blocked by 2, 3, 4, 5, 6
```

---

## Non-Functional Requirements

- All waffles must be served within 200ms response time.
- Syrup telemetry must not leak memory (bounded queue of 100 metrics).
- The system must gracefully reject any pancake-related requests.
- Butter distribution must be fair and equitable across all four quadrants.
