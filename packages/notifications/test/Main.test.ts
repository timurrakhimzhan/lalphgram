import { describe, expect, it, vi } from "@effect/vitest"
import { Duration, Effect, Layer, Stream } from "effect"
import {
  PRAutoMerged,
  PRCIFailed,
  PRCommentAdded,
  PRConflictDetected,
  PROpened,
  TaskCreated,
  TaskUpdated
} from "../src/Events.js"
import type { AutoMergeEvent, PullRequestEvent, TaskTrackerEvent } from "../src/Events.js"
import { BranchParserLive } from "../src/lib/BranchParser.js"
import { GitHubComment, GitHubPullRequest } from "../src/schemas/GitHubSchemas.js"
import { TrackerIssue } from "../src/schemas/TrackerSchemas.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/services/AppRuntimeConfig.js"
import { AutoMerge } from "../src/services/AutoMerge.js"
import { CommentTimer } from "../src/services/CommentTimer.js"
import {
  ABORT_BUTTON_LABEL,
  APPROVE_BUTTON_LABEL,
  BUFFER_BUTTON_LABEL,
  BUG_BUTTON_LABEL,
  FEATURE_BUTTON_LABEL,
  INTERRUPT_BUTTON_LABEL,
  OMIT_BUTTON_LABEL,
  OTHER_BUTTON_LABEL,
  PLAN_BUTTON_LABEL,
  REFACTOR_BUTTON_LABEL,
  runEventLoop
} from "../src/services/EventLoop.js"
import { GitHubClient } from "../src/services/GitHubClient.js"
import {
  IncomingMessage,
  MessengerAdapter,
  MessengerAdapterError
} from "../src/services/MessengerAdapter/MessengerAdapter.js"
import { PlanSession, PlanSpecReady } from "../src/services/PlanSession.js"
import { PullRequestTracker } from "../src/services/PullRequestTracker.js"
import { TaskTracker } from "../src/services/TaskTracker/TaskTracker.js"
import type { TaskTrackerService } from "../src/services/TaskTracker/TaskTracker.js"

const testRuntimeConfig = new RuntimeConfig({
  pollIntervalSeconds: 1,
  triggerKeyword: "urgent",
  timerDelaySeconds: 300
})

const makeIssue = () =>
  new TrackerIssue({
    id: "ISSUE-1",
    title: "Test Issue",
    state: "In Progress",
    url: "https://example.com/issue/1",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z"
  })

const makePR = () =>
  new GitHubPullRequest({
    id: 100,
    number: 1,
    title: "Test PR",
    state: "open",
    html_url: "https://github.com/owner/repo/pull/1",
    headRef: "ABC-123/feature",
    headSha: "abc123",
    hasConflicts: false,
    repo: "owner/repo"
  })

const makeComment = () =>
  new GitHubComment({
    id: 1,
    body: "Test comment",
    user: { login: "reviewer" },
    created_at: "2024-01-15T10:00:00Z",
    html_url: "https://github.com/owner/repo/pull/1#issuecomment-1",
    repo: "owner/repo"
  })

const makeAutoMergeMock = (autoMergeEvents: ReadonlyArray<AutoMergeEvent> = []) =>
  AutoMerge.of({
    eventStream: Stream.fromIterable(autoMergeEvents)
  })

const makeEventSourcesFromEvents = (
  prEvents: ReadonlyArray<PullRequestEvent>,
  taskEvents: ReadonlyArray<TaskTrackerEvent> = [],
  autoMergeEvents: ReadonlyArray<AutoMergeEvent> = []
) => ({
  githubEventSourceMock: PullRequestTracker.of({
    eventStream: Stream.fromIterable(prEvents)
  }),
  taskEvents,
  autoMergeMock: makeAutoMergeMock(autoMergeEvents)
})

const makeMessengerMock = (incomingMessages?: Stream.Stream<IncomingMessage>) =>
  MessengerAdapter.of({
    sendMessage: vi.fn(() => Effect.succeed(undefined)),
    incomingMessages: incomingMessages ?? Stream.empty
  })

const makeGitHubClientMock = () =>
  GitHubClient.of({
    getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "test-user" })),
    listUserRepos: vi.fn(() => Effect.succeed([])),
    listOpenPRs: vi.fn(() => Effect.succeed([])),
    getPR: vi.fn(() => Effect.succeed(makePR())),
    postComment: vi.fn(() => Effect.succeed(undefined)),
    listComments: vi.fn(() => Effect.succeed([])),
    listReviewComments: vi.fn(() => Effect.succeed([])),
    getCIStatus: vi.fn(() => Effect.succeed({ state: "success", checkRuns: [] })),
    mergePR: vi.fn(() => Effect.succeed(undefined))
  })

const makeTrackerMock = (): TaskTrackerService => ({
  eventStream: Stream.empty,
  moveToTodo: vi.fn(() => Effect.succeed(undefined)),
  setPriorityUrgent: vi.fn(() => Effect.succeed(undefined)),
  getIssue: vi.fn(() => Effect.succeed(makeIssue()))
})

const makeCommentTimerMock = () =>
  CommentTimer.of({
    handleComment: vi.fn(() => Effect.succeed(undefined)),
    shutdown: Effect.succeed(undefined)
  })

const makePlanSessionMock = () =>
  PlanSession.of({
    start: vi.fn(() => Effect.succeed(undefined)),
    answer: vi.fn(() => Effect.succeed(undefined)),
    sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
    interrupt: vi.fn(() => Effect.succeed(undefined)),
    approve: Effect.succeed(undefined),
    reject: Effect.succeed(undefined),
    isActive: Effect.succeed(false),
    events: Stream.never
  })

const makeTestLayer = (
  prEvents: ReadonlyArray<PullRequestEvent>,
  overrides: {
    messengerMock?: ReturnType<typeof makeMessengerMock>
    githubClientMock?: ReturnType<typeof makeGitHubClientMock>
    trackerMock?: TaskTrackerService
    commentTimerMock?: ReturnType<typeof makeCommentTimerMock>
    planSessionMock?: ReturnType<typeof makePlanSessionMock>
    taskEvents?: ReadonlyArray<TaskTrackerEvent>
    autoMergeEvents?: ReadonlyArray<AutoMergeEvent>
  } = {}
) => {
  const { autoMergeMock, githubEventSourceMock, taskEvents } = makeEventSourcesFromEvents(
    prEvents,
    overrides.taskEvents,
    overrides.autoMergeEvents
  )
  const messengerMock = overrides.messengerMock ?? makeMessengerMock()
  const githubClientMock = overrides.githubClientMock ?? makeGitHubClientMock()
  const baseTrackerMock = overrides.trackerMock ?? makeTrackerMock()
  const trackerMock: TaskTrackerService = {
    ...baseTrackerMock,
    eventStream: taskEvents.length > 0 ? Stream.fromIterable(taskEvents) : baseTrackerMock.eventStream
  }
  const commentTimerMock = overrides.commentTimerMock ?? makeCommentTimerMock()
  const planSessionMock = overrides.planSessionMock ?? makePlanSessionMock()

  return {
    layer: Layer.mergeAll(
      Layer.succeed(PullRequestTracker, githubEventSourceMock),
      Layer.succeed(AutoMerge, autoMergeMock),
      Layer.succeed(MessengerAdapter, messengerMock),
      Layer.succeed(GitHubClient, githubClientMock),
      Layer.succeed(TaskTracker, trackerMock),
      Layer.succeed(CommentTimer, commentTimerMock),
      Layer.succeed(PlanSession, planSessionMock),
      Layer.succeed(AppRuntimeConfig, testRuntimeConfig),
      BranchParserLive
    ),
    messengerMock,
    githubClientMock,
    trackerMock,
    commentTimerMock,
    planSessionMock
  }
}

describe("event loop dispatch", () => {
  it.effect("sends Telegram notification for TaskCreated events", () => {
    // Arrange
    const event = new TaskCreated({ issue: makeIssue() })
    const { layer, messengerMock } = makeTestLayer([], { taskEvents: [event] })

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>New task created</b>")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends Telegram notification for TaskUpdated events with state transition", () => {
    // Arrange
    const event = new TaskUpdated({ issue: makeIssue(), previousState: "In Progress" })
    const { layer, messengerMock } = makeTestLayer([], { taskEvents: [event] })

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>Task moved to In Progress</b>")
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("In Progress → In Progress")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends Telegram notification for PROpened events", () => {
    // Arrange
    const event = new PROpened({ pr: makePR() })
    const { layer, messengerMock } = makeTestLayer([event])

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>New PR opened</b>")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("posts comment, moves to todo, and sends Telegram for PRConflictDetected events", () => {
    // Arrange
    const pr = new GitHubPullRequest({
      id: 100,
      number: 1,
      title: "Conflicting PR",
      state: "open",
      html_url: "https://github.com/owner/repo/pull/1",
      headRef: "ABC-123/feature",
      headSha: "abc123",
      hasConflicts: true,
      repo: "owner/repo"
    })
    const event = new PRConflictDetected({ pr })
    const githubClientMock = makeGitHubClientMock()
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const { layer } = makeTestLayer([event], { githubClientMock, trackerMock, messengerMock })

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      expect(githubClientMock.postComment).toHaveBeenCalledWith(
        expect.objectContaining({ full_name: "owner/repo" }),
        1,
        "This PR has merge conflicts that need to be resolved."
      )
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("ABC-123")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>Conflict detected</b>")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("delegates PRCommentAdded events to CommentTimer", () => {
    // Arrange
    const pr = makePR()
    const comment = makeComment()
    const event = new PRCommentAdded({ pr, comment })
    const commentTimerMock = makeCommentTimerMock()
    const { layer } = makeTestLayer([event], { commentTimerMock })

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      expect(commentTimerMock.handleComment).toHaveBeenCalledWith(pr, comment)
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends Telegram notification for PRAutoMerged events", () => {
    // Arrange
    const pr = makePR()
    const event = new PRAutoMerged({ pr })
    const messengerMock = makeMessengerMock()
    const { layer } = makeTestLayer([], { messengerMock, autoMergeEvents: [event] })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>PR auto-merged</b>")
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("Test PR")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("moves to todo, sets priority urgent, and sends Telegram for PRCIFailed events", () => {
    // Arrange
    const pr = makePR()
    const event = new PRCIFailed({
      pr,
      failedChecks: [
        { name: "lint", html_url: "https://github.com/checks/1", conclusion: "failure" },
        { name: "test", html_url: "https://github.com/checks/2", conclusion: "failure" }
      ]
    })
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const { layer } = makeTestLayer([event], { trackerMock, messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop

      // Assert
      expect(trackerMock.moveToTodo).toHaveBeenCalledWith("ABC-123")
      expect(trackerMock.setPriorityUrgent).toHaveBeenCalledWith("ABC-123")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>CI failed</b>")
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("lint, test")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends Telegram for PRCIFailed when no issue ID in branch", () => {
    // Arrange
    const pr = new GitHubPullRequest({
      id: 100,
      number: 1,
      title: "Test PR",
      state: "open",
      html_url: "https://github.com/owner/repo/pull/1",
      headRef: "no-issue-id",
      headSha: "abc123",
      hasConflicts: false,
      repo: "owner/repo"
    })
    const event = new PRCIFailed({
      pr,
      failedChecks: [
        { name: "build", html_url: "https://github.com/checks/1", conclusion: "failure" }
      ]
    })
    const trackerMock = makeTrackerMock()
    const messengerMock = makeMessengerMock()
    const { layer } = makeTestLayer([event], { trackerMock, messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop

      // Assert
      expect(trackerMock.moveToTodo).not.toHaveBeenCalled()
      expect(trackerMock.setPriorityUrgent).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>CI failed</b>")
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("catches dispatch errors and continues processing", () => {
    // Arrange
    const event1 = new PROpened({ pr: makePR() })
    const event2 = new PRAutoMerged({ pr: makePR() })
    const callCount = { value: 0 }
    const messengerMock = MessengerAdapter.of({
      sendMessage: vi.fn(() => {
        callCount.value++
        // Call 1 is the startup Plan button; call 2 is the first event dispatch (fails)
        if (callCount.value === 2) {
          return Effect.fail(new MessengerAdapterError({ message: "API error", cause: null }))
        }
        return Effect.succeed(undefined)
      }),
      incomingMessages: Stream.empty
    })
    const { layer } = makeTestLayer([event1], { messengerMock, autoMergeEvents: [event2] })

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      // Startup message + both events processed even though the first event failed
      expect(messengerMock.sendMessage).toHaveBeenCalledTimes(3)
    }).pipe(Effect.provide(layer))
  })
})

describe("multi-step plan input", () => {
  it.effect("sends Plan button on startup", () => {
    // Arrange
    const { layer, messengerMock } = makeTestLayer([])

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "🚀 Notification service started.",
          replyKeyboard: [{ label: PLAN_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("shows type selection buttons when Plan is tapped", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "What type of change?",
          options: [
            { label: FEATURE_BUTTON_LABEL },
            { label: BUG_BUTTON_LABEL },
            { label: REFACTOR_BUTTON_LABEL },
            { label: OTHER_BUTTON_LABEL },
            { label: ABORT_BUTTON_LABEL }
          ]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("enters collection mode with Done keyboard when type is selected", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
      new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Done"),
          replyKeyboard: [{ label: "Done" }, { label: ABORT_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("sends feedback after each buffered message during collection", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
      new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" }),
      new IncomingMessage({ chatId: "1", text: "Add auth", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "✓ Added. Tap <b>Done</b> when ready."
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("collects messages and starts plan on Done", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
      new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" }),
      new IncomingMessage({ chatId: "1", text: "Add auth", from: "user" }),
      new IncomingMessage({ chatId: "1", text: "Use JWT", from: "user" }),
      new IncomingMessage({ chatId: "1", text: "Done", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const planSessionMock = makePlanSessionMock()
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.start).toHaveBeenCalledWith("Add auth\nUse JWT")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Planning started...",
          replyKeyboard: [{ label: ABORT_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("sends error when Done is tapped with empty buffer", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
      new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" }),
      new IncomingMessage({ chatId: "1", text: "Done", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const planSessionMock = makePlanSessionMock()
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.start).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("No plan description provided.")
    }).pipe(Effect.provide(layer))
  })
})

describe("plan spec approval", () => {
  it.live("sends approval message with buttons on PlanSpecReady", () => {
    // Arrange
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(false),
      events: Stream.make(new PlanSpecReady({}))
    })
    const messengerMock = makeMessengerMock()
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Spec ready. Reply with questions or approve to proceed.",
          replyKeyboard: [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("calls approve on plan session when Approve button is tapped", () => {
    // Arrange
    const approveFn = vi.fn(() => Effect.succeed(undefined))
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: approveFn(),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.make(
      new IncomingMessage({ chatId: "1", text: APPROVE_BUTTON_LABEL, from: "user" })
    )
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(approveFn).toHaveBeenCalled()
    }).pipe(Effect.provide(layer))
  })
})

describe("follow-up buffer vs interrupt choice", () => {
  it.live("shows Buffer/Interrupt buttons when text arrives during active session", () => {
    // Arrange
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.make(
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" })
    )
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.sendFollowUp).not.toHaveBeenCalled()
      expect(planSessionMock.interrupt).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Send as follow-up or interrupt Claude?",
          options: [
            { label: BUFFER_BUTTON_LABEL },
            { label: INTERRUPT_BUTTON_LABEL },
            { label: OMIT_BUTTON_LABEL },
            { label: ABORT_BUTTON_LABEL }
          ]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("buffers follow-up when Buffer button is tapped", () => {
    // Arrange
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: BUFFER_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.sendFollowUp).toHaveBeenCalledWith("Also add tests")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "Message buffered — Claude will process it shortly."
      )
    }).pipe(Effect.provide(layer))
  })

  it.live("discards follow-up when Omit button is tapped", () => {
    // Arrange
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: OMIT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.sendFollowUp).not.toHaveBeenCalled()
      expect(planSessionMock.interrupt).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Message discarded.")
    }).pipe(Effect.provide(layer))
  })

  it.live("interrupts Claude when Interrupt button is tapped", () => {
    // Arrange
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: INTERRUPT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.interrupt).toHaveBeenCalledWith("Also add tests")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "Claude interrupted — processing your message now."
      )
    }).pipe(Effect.provide(layer))
  })
})

describe("plan abort", () => {
  it.live("aborts during collection mode", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
      new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" }),
      new IncomingMessage({ chatId: "1", text: "Add auth", from: "user" }),
      new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const planSessionMock = makePlanSessionMock()
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(planSessionMock.start).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Plan aborted.")
    }).pipe(Effect.provide(layer))
  })

  it.live("aborts active plan session", () => {
    // Arrange
    const rejectFn = vi.fn(() => Effect.succeed(undefined))
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: rejectFn(),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.make(
      new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" })
    )
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(rejectFn).toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Plan aborted.")
    }).pipe(Effect.provide(layer))
  })

  it.live("aborts and clears pending follow-up", () => {
    // Arrange
    const rejectFn = vi.fn(() => Effect.succeed(undefined))
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: rejectFn(),
      isActive: Effect.succeed(true),
      events: Stream.never
    })
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* runEventLoop
      yield* Effect.sleep(Duration.millis(50))

      // Assert
      expect(rejectFn).toHaveBeenCalled()
      expect(planSessionMock.sendFollowUp).not.toHaveBeenCalled()
      expect(planSessionMock.interrupt).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Plan aborted.")
    }).pipe(Effect.provide(layer))
  })
})
