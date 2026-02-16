import { Chunk, Duration, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { AppEvent } from "../src/Events.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/schemas/CredentialSchemas.js"
import { TrackerIssue, TrackerIssueEvent } from "../src/schemas/TrackerSchemas.js"
import { TaskEventSource, TaskEventSourceLive } from "../src/services/TaskEventSource.js"
import { TaskTracker, TaskTrackerError } from "../src/services/TaskTracker.js"
import type { TaskTrackerService } from "../src/services/TaskTracker.js"

const runtimeConfig = new RuntimeConfig({
  pollIntervalSeconds: 0.001,
  triggerKeyword: "urgent",
  timerDelaySeconds: 300
})

const runtimeConfigLayer = Layer.succeed(AppRuntimeConfig, runtimeConfig)

const makeIssue = (overrides: Partial<{
  id: string
  title: string
  state: string
}> = {}) =>
  new TrackerIssue({
    id: overrides.id ?? "ISSUE-1",
    title: overrides.title ?? "Test Issue",
    state: overrides.state ?? "In Progress",
    url: "https://example.com/issue/1",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z"
  })

const makeTrackerMock = (overrides: Partial<{
  getRecentEvents: (since: string) => Effect.Effect<ReadonlyArray<TrackerIssueEvent>, TaskTrackerError>
}> = {}): TaskTrackerService => ({
  getRecentEvents: overrides.getRecentEvents ?? vi.fn(() => Effect.succeed([])),
  moveToTodo: vi.fn(() => Effect.succeed(undefined)),
  setPriorityUrgent: vi.fn(() => Effect.succeed(undefined)),
  getIssue: vi.fn(() => Effect.succeed(makeIssue()))
})

const makeTestLayer = (trackerMock: TaskTrackerService) =>
  TaskEventSourceLive.pipe(
    Layer.provide(Layer.succeed(TaskTracker, trackerMock)),
    Layer.provide(runtimeConfigLayer)
  )

const collectEventsFor = (ms: number) =>
  Effect.gen(function*() {
    const source = yield* TaskEventSource
    const collected = yield* Ref.make<Array<AppEvent>>([])
    const fiber = yield* source.stream.pipe(
      Stream.runForEach((event) => Ref.update(collected, (arr) => [...arr, event])),
      Effect.fork
    )
    yield* Effect.sleep(Duration.millis(ms))
    yield* Fiber.interrupt(fiber)
    return yield* Ref.get(collected)
  })

const takeEvents = (n: number) =>
  Effect.gen(function*() {
    const source = yield* TaskEventSource
    return yield* source.stream.pipe(
      Stream.take(n),
      Stream.runCollect,
      Effect.map(Chunk.toArray)
    )
  })

describe("TaskEventSource", () => {
  it("maps TrackerIssueEvent with action created to TaskCreated", () => {
    // Arrange
    const issue = makeIssue({ id: "ISSUE-1", title: "New task" })
    const trackerMock = makeTrackerMock({
      getRecentEvents: vi.fn(() => Effect.succeed([new TrackerIssueEvent({ action: "created", issue })]))
    })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(trackerMock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]?._tag).toBe("TaskCreated")
        if (events[0] && "issue" in events[0]) {
          expect(events[0].issue.id).toBe("ISSUE-1")
        }
      }),
      Effect.runPromise
    )
  })

  it("emits TaskUpdated with previousState when state changes", () => {
    // Arrange
    let callCount = 0
    const trackerMock = makeTrackerMock({
      getRecentEvents: vi.fn(() => {
        callCount++
        if (callCount === 1) {
          return Effect.succeed([
            new TrackerIssueEvent({ action: "updated", issue: makeIssue({ id: "ISSUE-2", state: "Todo" }) })
          ])
        }
        return Effect.succeed([
          new TrackerIssueEvent({ action: "updated", issue: makeIssue({ id: "ISSUE-2", state: "In Progress" }) })
        ])
      })
    })

    // Act
    return takeEvents(2).pipe(
      Effect.provide(makeTestLayer(trackerMock)),
      Effect.map((events) => {
        // Assert
        const updated = events.filter((e) => e._tag === "TaskUpdated")
        expect(updated).toHaveLength(2)
        if (updated[1] && "previousState" in updated[1]) {
          expect(updated[1].previousState).toBe("Todo")
        }
      }),
      Effect.runPromise
    )
  })

  it("filters out updates when state has not changed", () => {
    // Arrange
    let callCount = 0
    const trackerMock = makeTrackerMock({
      getRecentEvents: vi.fn(() => {
        callCount++
        if (callCount === 1) {
          return Effect.succeed([
            new TrackerIssueEvent({ action: "updated", issue: makeIssue({ id: "ISSUE-3", state: "Todo" }) })
          ])
        }
        return Effect.succeed([
          new TrackerIssueEvent({ action: "updated", issue: makeIssue({ id: "ISSUE-3", state: "Todo" }) })
        ])
      })
    })

    // Act — collect for enough time to get 2+ poll cycles
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(trackerMock)),
      Effect.map((events) => {
        // Assert — only the first update should be emitted (unknown → Todo), second is filtered
        const updated = events.filter((e) => e._tag === "TaskUpdated")
        expect(updated).toHaveLength(1)
      }),
      Effect.runPromise
    )
  })

  it("handles poll cycle errors by logging and emitting empty batch", () => {
    // Arrange
    const trackerMock = makeTrackerMock({
      getRecentEvents: vi.fn(() => Effect.fail(new TaskTrackerError({ message: "API error", cause: null })))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(trackerMock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(trackerMock.getRecentEvents).toHaveBeenCalled()
      }),
      Effect.runPromise
    )
  })
})
