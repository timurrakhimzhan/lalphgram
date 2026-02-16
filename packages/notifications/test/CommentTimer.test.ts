import { describe, expect, it, vi } from "@effect/vitest"
import { Duration, Effect, Layer, Stream } from "effect"
import { BranchParserLive } from "../src/lib/BranchParser.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/schemas/CredentialSchemas.js"
import { GitHubComment, GitHubPullRequest } from "../src/schemas/GitHubSchemas.js"
import { CommentTimer, CommentTimerLive } from "../src/services/CommentTimer.js"
import type { MessengerAdapterError } from "../src/services/MessengerAdapter.js"
import { MessengerAdapter } from "../src/services/MessengerAdapter.js"
import { TaskTracker, TaskTrackerError } from "../src/services/TaskTracker.js"
import type { TaskTrackerService } from "../src/services/TaskTracker.js"

const runtimeConfig = new RuntimeConfig({
  pollIntervalSeconds: 1,
  triggerKeyword: "urgent",
  timerDelaySeconds: 0.5
})

const runtimeConfigLayer = Layer.succeed(AppRuntimeConfig, runtimeConfig)

const makePR = (overrides: Partial<{
  number: number
  headRef: string
  headSha: string
  repo: string
}> = {}) =>
  new GitHubPullRequest({
    id: 100,
    number: overrides.number ?? 1,
    title: "Test PR",
    state: "open",
    html_url: "https://github.com/owner/my-repo/pull/1",
    headRef: overrides.headRef ?? "ABC-123/feature",
    headSha: overrides.headSha ?? "abc123",
    hasConflicts: false,
    repo: overrides.repo ?? "owner/my-repo"
  })

const makeComment = (overrides: Partial<{
  body: string
}> = {}) =>
  new GitHubComment({
    id: 1,
    body: overrides.body ?? "Some comment",
    user: { login: "reviewer" },
    created_at: "2024-01-15T10:00:00Z",
    html_url: "https://github.com/owner/my-repo/pull/1#issuecomment-1",
    repo: "owner/my-repo"
  })

const makeTrackerMock = (overrides: Partial<{
  moveToTodo: (issueId: string) => Effect.Effect<void, TaskTrackerError>
}> = {}): TaskTrackerService => ({
  getRecentEvents: vi.fn(() => Effect.succeed([])),
  moveToTodo: overrides.moveToTodo ?? vi.fn(() => Effect.succeed(undefined)),
  setPriorityUrgent: vi.fn(() => Effect.succeed(undefined)),
  getIssue: vi.fn(() =>
    Effect.succeed({
      id: "ABC-123",
      title: "Test Issue",
      state: "In Progress",
      url: "https://example.com",
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z"
    })
  )
})

const makeMessengerMock = (overrides: Partial<{
  sendMessage: (text: string) => Effect.Effect<void, MessengerAdapterError>
}> = {}) =>
  MessengerAdapter.of({
    sendMessage: overrides.sendMessage ?? vi.fn(() => Effect.succeed(undefined)),
    incomingMessages: Stream.empty
  })

const makeTestLayer = (
  trackerMock: TaskTrackerService,
  messengerMock: ReturnType<typeof makeMessengerMock>
) =>
  CommentTimerLive.pipe(
    Layer.provide(Layer.succeed(TaskTracker, trackerMock)),
    Layer.provide(Layer.succeed(MessengerAdapter, messengerMock)),
    Layer.provide(runtimeConfigLayer),
    Layer.provide(BranchParserLive)
  )

describe("CommentTimer", () => {
  it.live("immediately calls moveToTodo and sendMessage when comment contains trigger keyword", () => {
    // Arrange
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "ABC-123/feature" })
    const comment = makeComment({ body: "This is URGENT please fix" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment)

      // Assert
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("ABC-123")
      expect(messengerMock.sendMessage).toHaveBeenCalled()
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("resolves GitHub issue branch to owner/repo#number format", () => {
    // Arrange
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "#42/fix-something", repo: "octocat/hello-world" })
    const comment = makeComment({ body: "This is URGENT please fix" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment)

      // Assert
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("octocat/hello-world#42")
      expect(messengerMock.sendMessage).toHaveBeenCalled()
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("logs warning and returns when no issue ID found in branch name", () => {
    // Arrange
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "main" })
    const comment = makeComment({ body: "Some comment" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment)

      // Assert
      expect(trackerMock.moveToTodo).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).not.toHaveBeenCalled()
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("forks a debounce timer when comment does not contain trigger keyword", () => {
    // Arrange
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "ABC-123/feature" })
    const comment = makeComment({ body: "Please review" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment)

      // Assert — actions not called immediately
      expect(trackerMock.moveToTodo).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).not.toHaveBeenCalled()

      // Wait for timer to fire
      yield* Effect.sleep(Duration.millis(600))

      // Assert — actions called after delay
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("ABC-123")
      expect(messengerMock.sendMessage).toHaveBeenCalled()
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("cancels existing timer when new comment arrives for same PR", () => {
    // Arrange
    const moveToTodoFn = vi.fn(() => Effect.succeed(undefined))
    const trackerMock = makeTrackerMock({ moveToTodo: moveToTodoFn })
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "ABC-123/feature" })
    const comment1 = makeComment({ body: "First comment" })
    const comment2 = makeComment({ body: "Second comment" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment1)
      yield* Effect.sleep(Duration.millis(200))
      yield* timer.handleComment(pr, comment2)
      yield* Effect.sleep(Duration.millis(600))

      // Assert — moveToTodo called only once (first timer was cancelled)
      expect(moveToTodoFn).toHaveBeenCalledTimes(1)
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("handles trigger keyword case-insensitively", () => {
    // Arrange
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "ABC-123/feature" })
    const comment = makeComment({ body: "This is UrGeNt!" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment)

      // Assert
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("ABC-123")
      expect(messengerMock.sendMessage).toHaveBeenCalled()
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("shutdown interrupts all active timer fibers", () => {
    // Arrange
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const pr1 = makePR({ headRef: "ABC-123/feature", number: 1 })
    const pr2 = makePR({ headRef: "DEF-456/fix", number: 2 })
    const comment = makeComment({ body: "Please review" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr1, comment)
      yield* timer.handleComment(pr2, comment)
      yield* timer.shutdown

      // Wait past the timer delay
      yield* Effect.sleep(Duration.millis(600))

      // Assert — no actions fired because shutdown interrupted fibers
      expect(trackerMock.moveToTodo).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).not.toHaveBeenCalled()
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("handles different PRs independently with separate timers", () => {
    // Arrange
    const moveToTodoFn = vi.fn(() => Effect.succeed(undefined))
    const trackerMock = makeTrackerMock({ moveToTodo: moveToTodoFn })
    const messengerMock = makeMessengerMock()
    const pr1 = makePR({ headRef: "ABC-123/feature", number: 1 })
    const pr2 = makePR({ headRef: "DEF-456/fix", number: 2 })
    const comment = makeComment({ body: "Please review" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr1, comment)
      yield* timer.handleComment(pr2, comment)

      // Wait for both timers to fire
      yield* Effect.sleep(Duration.millis(600))

      // Assert — both PRs triggered independently
      expect(moveToTodoFn).toHaveBeenCalledTimes(2)
      expect(moveToTodoFn).toHaveBeenCalledWith("ABC-123")
      expect(moveToTodoFn).toHaveBeenCalledWith("DEF-456")
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })

  it.live("timer fiber catches errors and logs them without propagating", () => {
    // Arrange
    const trackerMock = makeTrackerMock({
      moveToTodo: vi.fn(() => Effect.fail(new TaskTrackerError({ message: "API error", cause: null })))
    })
    const messengerMock = makeMessengerMock()
    const pr = makePR({ headRef: "ABC-123/feature" })
    const comment = makeComment({ body: "Please review" })

    // Act
    return Effect.gen(function*() {
      const timer = yield* CommentTimer
      yield* timer.handleComment(pr, comment)

      // Wait for timer to fire and handle error
      yield* Effect.sleep(Duration.millis(600))

      // Assert — no error propagated, moveToTodo was attempted
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("ABC-123")
    }).pipe(
      Effect.provide(makeTestLayer(trackerMock, messengerMock))
    )
  })
})
