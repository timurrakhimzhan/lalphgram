import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, Option, Queue, Stream } from "effect"
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
import { LalphProject } from "../src/schemas/ProjectSchemas.js"
import { TrackerIssue } from "../src/schemas/TrackerSchemas.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/services/AppRuntimeConfig.js"
import { AutoMerge } from "../src/services/AutoMerge.js"
import { CommentTimer } from "../src/services/CommentTimer.js"
import {
  ABORT_BUTTON_LABEL,
  APPROVE_BUTTON_LABEL,
  BUFFER_BUTTON_LABEL,
  BUG_BUTTON_LABEL,
  DISCARD_BUTTON_LABEL,
  FEATURE_BUTTON_LABEL,
  INTERRUPT_BUTTON_LABEL,
  NEW_PROJECT_BUTTON_LABEL,
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
import { OctokitClient } from "../src/services/OctokitClient.js"
import type { OctokitClientService } from "../src/services/OctokitClient.js"
import { PlanOverviewUploader, PlanOverviewUploaderError } from "../src/services/PlanOverviewUploader.js"
import type { PlanEvent } from "../src/services/PlanSession.js"
import {
  PlanAnalysisReady,
  PlanAwaitingInput,
  PlanQuestion,
  PlanSession,
  PlanSessionError,
  PlanSpecCreated
} from "../src/services/PlanSession.js"
import { ProjectStore } from "../src/services/ProjectStore.js"
import { PullRequestTracker } from "../src/services/PullRequestTracker.js"
import { TaskTracker } from "../src/services/TaskTracker/TaskTracker.js"
import type { TaskTrackerService } from "../src/services/TaskTracker/TaskTracker.js"

/** Yield enough scheduler turns for the daemon fiber to drain all queued stream elements. */
const flush = Effect.yieldNow().pipe(Effect.repeatN(100))

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

const makeOctokitClientMock = (overrides?: Partial<OctokitClientService>) =>
  OctokitClient.of({
    getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "test-user" })),
    listUserRepos: vi.fn(() => Effect.succeed([])),
    listPulls: vi.fn(() => Effect.succeed([])),
    getPull: vi.fn(() =>
      Effect.succeed({
        id: 1,
        number: 1,
        title: "",
        state: "open",
        htmlUrl: "",
        head: { ref: "", sha: "" },
        mergeable: null
      })
    ),
    createIssueComment: vi.fn(() => Effect.void),
    listIssueComments: vi.fn(() => Effect.succeed([])),
    listUserIssues: vi.fn(() => Effect.succeed([])),
    getIssue: vi.fn(() =>
      Effect.succeed({ number: 1, title: "", state: "open", htmlUrl: "", createdAt: "", updatedAt: "" })
    ),
    addIssueLabels: vi.fn(() => Effect.void),
    listPullReviewComments: vi.fn(() => Effect.succeed([])),
    getCombinedStatusForRef: vi.fn(() => Effect.succeed({ state: "success", statuses: [] })),
    listCheckRunsForRef: vi.fn(() => Effect.succeed([])),
    mergePull: vi.fn(() => Effect.succeed({ sha: "", merged: true, message: "" })),
    createGist: vi.fn(() =>
      Effect.succeed({
        id: "gist-123",
        htmlUrl: "https://gist.github.com/gist-123",
        files: { "spec.html": { rawUrl: "https://gist.githubusercontent.com/raw/spec.html" } }
      })
    ),
    ...overrides
  })

const readFailure = Effect.fail(new PlanSessionError({ message: "no specs dir", cause: null }))

const makePlanSessionMock = (overrides?: { isIdle?: Effect.Effect<boolean> }) =>
  PlanSession.of({
    start: vi.fn(() => Effect.succeed(undefined)),
    answer: vi.fn(() => Effect.succeed(undefined)),
    sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
    interrupt: vi.fn(() => Effect.succeed(undefined)),
    approve: Effect.succeed(undefined),
    reject: Effect.succeed(undefined),
    isActive: Effect.succeed(false),
    isIdle: overrides?.isIdle ?? Effect.succeed(false),
    readFeatureAnalysis: readFailure,
    readBugAnalysis: readFailure,
    readRefactorAnalysis: readFailure,
    readDefaultAnalysis: readFailure,
    events: Stream.never
  })

const defaultProject = new LalphProject({
  id: "default-project",
  enabled: true,
  targetBranch: Option.none(),
  concurrency: 1,
  gitFlow: "pr",
  reviewAgent: false
})

const makeProjectStoreMock = (overrides?: {
  listProjects?: Effect.Effect<ReadonlyArray<LalphProject>>
}) =>
  ProjectStore.of({
    listProjects: overrides?.listProjects ?? Effect.succeed([defaultProject]),
    getProject: vi.fn((id: string) => Effect.succeed(new LalphProject({ ...defaultProject, id }))),
    createProject: vi.fn((data) =>
      Effect.succeed(
        new LalphProject({
          id: data.id,
          enabled: true,
          targetBranch: data.targetBranch,
          concurrency: data.concurrency,
          gitFlow: data.gitFlow,
          reviewAgent: data.reviewAgent
        })
      )
    )
  })

const makePlanOverviewUploaderMock = () =>
  PlanOverviewUploader.of({
    upload: vi.fn(() => Effect.succeed({ url: "https://telegra.ph/test-spec" }))
  })

const makeTestLayer = (
  prEvents: ReadonlyArray<PullRequestEvent>,
  overrides: {
    messengerMock?: ReturnType<typeof makeMessengerMock>
    githubClientMock?: ReturnType<typeof makeGitHubClientMock>
    trackerMock?: TaskTrackerService
    commentTimerMock?: ReturnType<typeof makeCommentTimerMock>
    planSessionMock?: ReturnType<typeof makePlanSessionMock>
    octokitClientMock?: ReturnType<typeof makeOctokitClientMock>
    projectStoreMock?: ReturnType<typeof makeProjectStoreMock>
    planOverviewUploaderMock?: ReturnType<typeof makePlanOverviewUploaderMock>
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
  const octokitClientMock = overrides.octokitClientMock ?? makeOctokitClientMock()
  const projectStoreMock = overrides.projectStoreMock ?? makeProjectStoreMock()
  const planOverviewUploaderMock = overrides.planOverviewUploaderMock ?? makePlanOverviewUploaderMock()

  return {
    layer: Layer.mergeAll(
      Layer.succeed(PullRequestTracker, githubEventSourceMock),
      Layer.succeed(AutoMerge, autoMergeMock),
      Layer.succeed(MessengerAdapter, messengerMock),
      Layer.succeed(GitHubClient, githubClientMock),
      Layer.succeed(TaskTracker, trackerMock),
      Layer.succeed(CommentTimer, commentTimerMock),
      Layer.succeed(PlanSession, planSessionMock),
      Layer.succeed(ProjectStore, projectStoreMock),
      Layer.succeed(AppRuntimeConfig, testRuntimeConfig),
      Layer.succeed(OctokitClient, octokitClientMock),
      Layer.succeed(PlanOverviewUploader, planOverviewUploaderMock),
      BranchParserLive
    ),
    messengerMock,
    githubClientMock,
    trackerMock,
    commentTimerMock,
    planSessionMock,
    octokitClientMock,
    projectStoreMock,
    planOverviewUploaderMock
  }
}

describe("event loop dispatch", () => {
  it.effect("sends Telegram notification for TaskCreated events", () => {
    // Arrange
    const event = new TaskCreated({ issue: makeIssue() })
    const { layer, messengerMock } = makeTestLayer([], { taskEvents: [event] })

    // Act & Assert
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

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
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "🚀 Notification service started.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows type selection buttons when Plan is tapped", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

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

  it.effect("enters collection mode with Done keyboard when type is selected", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
      new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Done"),
          replyKeyboard: [{ label: "Done" }, { label: ABORT_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends feedback after each buffered message during collection", () => {
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
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "✓ Added. Tap <b>Done</b> when ready."
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("collects messages and starts plan on Done", () => {
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
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.start).toHaveBeenCalledWith("Add auth\nUse JWT", undefined, undefined)
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Planning started...",
          replyKeyboard: [{ label: ABORT_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends error when Done is tapped with empty buffer", () => {
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
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.start).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("No plan description provided.")
    }).pipe(Effect.provide(layer))
  })
})

const planSetupMessages = [
  new IncomingMessage({ chatId: "1", text: "Plan", from: "user" }),
  new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" }),
  new IncomingMessage({ chatId: "1", text: "plan text", from: "user" }),
  new IncomingMessage({ chatId: "1", text: "Done", from: "user" })
]

describe("plan spec approval", () => {
  it.effect("does not show Approve when spec is missing", () => {
    // Arrange — analysis + idle but no spec
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: Effect.succeed(undefined),
      isActive: Effect.succeed(false),
      isIdle: Effect.succeed(false),
      readFeatureAnalysis: readFailure,
      readBugAnalysis: readFailure,
      readRefactorAnalysis: readFailure,
      readDefaultAnalysis: readFailure,
      events: Stream.make(
        new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
        new PlanAwaitingInput({})
      )
    })
    const messengerMock = makeMessengerMock()
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert — Approve keyboard never shown
      expect(messengerMock.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Spec ready. Reply with questions or approve to proceed.",
          replyKeyboard: [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows Approve when spec + analysis + idle are all met", () =>
    Effect.gen(function*() {
      // Arrange — all three conditions, plan events queued after setup
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: vi.fn(() => Effect.succeed(undefined)),
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: Effect.succeed(undefined),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: readFailure,
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.fromQueue(planEventQueue)
      })
      const incomingQueue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(incomingQueue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(incomingQueue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offerAll(planEventQueue, [
        new PlanSpecCreated({ filePath: ".specs/feature.md" }),
        new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
        new PlanAwaitingInput({})
      ])
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Spec ready. Reply with questions or approve to proceed.",
          replyKeyboard: [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
        })
      )
    }))

  it.effect("calls approve on plan session when Approve button is tapped", () =>
    Effect.gen(function*() {
      // Arrange
      const approveFn = vi.fn(() => Effect.succeed(undefined))
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: vi.fn(() => Effect.succeed(undefined)),
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: approveFn(),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: readFailure,
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.make(
          new PlanSpecCreated({ filePath: ".specs/feature.md" }),
          new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
          new PlanAwaitingInput({})
        )
      })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act — fork so the daemon processes all events before Approve arrives
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: APPROVE_BUTTON_LABEL, from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert
      expect(approveFn).toHaveBeenCalled()
    }))

  it.effect("uploads spec and sends URL when all conditions met", () =>
    Effect.gen(function*() {
      // Arrange
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planOverviewUploaderMock = makePlanOverviewUploaderMock()
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: vi.fn(() => Effect.succeed(undefined)),
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: Effect.succeed(undefined),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: Effect.succeed({
          analysis: "# Analysis\nDesign summary",
          services: "classDiagram\nclass Foo",
          test: "# Tests\n- test case 1"
        }),
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.fromQueue(planEventQueue)
      })
      const incomingQueue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(incomingQueue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(incomingQueue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock, planOverviewUploaderMock })

      // Act — process setup messages first, then fire plan events
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offerAll(planEventQueue, [
        new PlanSpecCreated({ filePath: ".specs/feature.md" }),
        new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
        new PlanAwaitingInput({})
      ])
      yield* flush

      // Assert — upload called and URL sent
      expect(planOverviewUploaderMock.upload).toHaveBeenCalledWith({
        files: expect.arrayContaining([expect.objectContaining({ name: "analysis.md" })]),
        description: "Spec: Feature"
      })
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("telegra.ph")
      )
      // No raw file headers sent
      expect(messengerMock.sendMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("<b>analysis.md</b>")
      )
      // Approve keyboard still shown
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Spec ready. Reply with questions or approve to proceed.",
          replyKeyboard: [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
        })
      )
    }))

  it.effect("includes mermaid content in uploaded HTML", () =>
    Effect.gen(function*() {
      // Arrange
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planOverviewUploaderMock = makePlanOverviewUploaderMock()
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: vi.fn(() => Effect.succeed(undefined)),
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: Effect.succeed(undefined),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: Effect.succeed({
          analysis: "summary",
          services: "classDiagram\nclass Foo",
          test: "test plan"
        }),
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.fromQueue(planEventQueue)
      })
      const incomingQueue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(incomingQueue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(incomingQueue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock, planOverviewUploaderMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offerAll(planEventQueue, [
        new PlanSpecCreated({ filePath: ".specs/feature.md" }),
        new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
        new PlanAwaitingInput({})
      ])
      yield* flush

      // Assert — uploaded HTML contains mermaid pre tag
      expect(planOverviewUploaderMock.upload).toHaveBeenCalledWith({
        files: expect.arrayContaining([expect.objectContaining({ name: "services.mmd", mermaid: true })]),
        description: expect.any(String)
      })
    }))

  it.effect("falls back to raw text when upload fails", () =>
    Effect.gen(function*() {
      // Arrange
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planOverviewUploaderMock = PlanOverviewUploader.of({
        upload: vi.fn(() => Effect.fail(new PlanOverviewUploaderError({ message: "API error", cause: null })))
      })
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: vi.fn(() => Effect.succeed(undefined)),
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: Effect.succeed(undefined),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: Effect.succeed({
          analysis: "# Analysis\nDesign summary",
          services: "classDiagram\nclass Foo",
          test: "# Tests\n- test case 1"
        }),
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.fromQueue(planEventQueue)
      })
      const incomingQueue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(incomingQueue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(incomingQueue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock, planOverviewUploaderMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offerAll(planEventQueue, [
        new PlanSpecCreated({ filePath: ".specs/feature.md" }),
        new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
        new PlanAwaitingInput({})
      ])
      yield* flush

      // Assert — falls back to raw text (file headers sent, no upload URL)
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>analysis.md</b>")
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>services.mmd</b>")
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining("<b>test.md</b>")
      )
      expect(messengerMock.sendMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("telegra.ph")
      )
    }))

  it.effect("shows Approve even when read fails", () =>
    Effect.gen(function*() {
      // Arrange — all read methods fail, plan events queued after setup
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: vi.fn(() => Effect.succeed(undefined)),
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: Effect.succeed(undefined),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: readFailure,
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.fromQueue(planEventQueue)
      })
      const incomingQueue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(incomingQueue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(incomingQueue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offerAll(planEventQueue, [
        new PlanSpecCreated({ filePath: ".specs/feature.md" }),
        new PlanAnalysisReady({ filePath: ".specs/analysis.md" }),
        new PlanAwaitingInput({})
      ])
      yield* flush

      // Assert — Approve keyboard still shown, no file headers sent
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Spec ready. Reply with questions or approve to proceed.",
          replyKeyboard: [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
        })
      )
      expect(messengerMock.sendMessage).not.toHaveBeenCalledWith(
        expect.stringContaining("<b>analysis.md</b>")
      )
    }))
})

describe("follow-up buffer vs interrupt choice", () => {
  it.effect("shows Buffer/Interrupt buttons when text arrives during active session", () => {
    // Arrange
    const planSessionMock = makePlanSessionMock()
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.sendFollowUp).not.toHaveBeenCalled()
      expect(planSessionMock.interrupt).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Send as follow-up or interrupt Claude?",
          options: [
            { label: BUFFER_BUTTON_LABEL },
            { label: INTERRUPT_BUTTON_LABEL },
            { label: DISCARD_BUTTON_LABEL }
          ]
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("buffers follow-up when Buffer button is tapped", () => {
    // Arrange
    const planSessionMock = makePlanSessionMock()
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: BUFFER_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.sendFollowUp).toHaveBeenCalledWith("Also add tests")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "Message buffered — Claude will process it shortly."
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("discards follow-up when Omit button is tapped", () => {
    // Arrange
    const planSessionMock = makePlanSessionMock()
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: DISCARD_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.sendFollowUp).not.toHaveBeenCalled()
      expect(planSessionMock.interrupt).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Message discarded.")
    }).pipe(Effect.provide(layer))
  })

  it.effect("interrupts Claude when Interrupt button is tapped", () => {
    // Arrange
    const planSessionMock = makePlanSessionMock()
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: INTERRUPT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.interrupt).toHaveBeenCalledWith("Also add tests")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "Claude interrupted — processing your message now."
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends follow-up directly when Claude is idle (no menu)", () => {
    // Arrange
    const planSessionMock = makePlanSessionMock({ isIdle: Effect.succeed(true) })
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert — follow-up sent directly, no menu shown
      expect(planSessionMock.sendFollowUp).toHaveBeenCalledWith("Also add tests")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Follow-up sent.")
      expect(messengerMock.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Send as follow-up or interrupt Claude?"
        })
      )
    }).pipe(Effect.provide(layer))
  })
})

describe("plan abort", () => {
  it.effect("aborts during collection mode", () => {
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
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(planSessionMock.start).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Plan aborted.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("aborts active plan session", () => {
    // Arrange
    const rejectFn = vi.fn(() => Effect.succeed(undefined))
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: rejectFn(),
      isActive: Effect.succeed(false),
      isIdle: Effect.succeed(false),
      readFeatureAnalysis: readFailure,
      readBugAnalysis: readFailure,
      readRefactorAnalysis: readFailure,
      readDefaultAnalysis: readFailure,
      events: Stream.never
    })
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(rejectFn).toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Plan aborted.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("aborts and clears pending follow-up", () => {
    // Arrange
    const rejectFn = vi.fn(() => Effect.succeed(undefined))
    const planSessionMock = PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: vi.fn(() => Effect.succeed(undefined)),
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: rejectFn(),
      isActive: Effect.succeed(false),
      isIdle: Effect.succeed(false),
      readFeatureAnalysis: readFailure,
      readBugAnalysis: readFailure,
      readRefactorAnalysis: readFailure,
      readDefaultAnalysis: readFailure,
      events: Stream.never
    })
    const incomingStream = Stream.fromIterable([
      ...planSetupMessages,
      new IncomingMessage({ chatId: "1", text: "Also add tests", from: "user" }),
      new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(rejectFn).toHaveBeenCalled()
      expect(planSessionMock.sendFollowUp).not.toHaveBeenCalled()
      expect(planSessionMock.interrupt).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Plan aborted.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }).pipe(Effect.provide(layer))
  })
})

describe("my own answer flow", () => {
  const questionEvent = new PlanQuestion({
    questions: [{
      question: "Which approach?",
      header: "Approach",
      options: [{ label: "Option A" }, { label: "Option B" }]
    }]
  })

  const makeQuestionPlanSession = (overrides?: {
    answerFn?: ReturnType<typeof vi.fn>
    rejectFn?: ReturnType<typeof vi.fn>
    events?: Stream.Stream<PlanEvent>
  }) => {
    const answerFn = overrides?.answerFn ?? vi.fn(() => Effect.succeed(undefined))
    const rejectFn = overrides?.rejectFn ?? vi.fn(() => Effect.succeed(undefined))
    return PlanSession.of({
      start: vi.fn(() => Effect.succeed(undefined)),
      answer: answerFn,
      sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
      interrupt: vi.fn(() => Effect.succeed(undefined)),
      approve: Effect.succeed(undefined),
      reject: rejectFn(),
      isActive: Effect.succeed(false),
      isIdle: Effect.succeed(false),
      readFeatureAnalysis: readFailure,
      readBugAnalysis: readFailure,
      readRefactorAnalysis: readFailure,
      readDefaultAnalysis: readFailure,
      events: overrides?.events ?? Stream.make(questionEvent)
    })
  }

  it.effect("prompts for free-text then forwards typed answer", () =>
    Effect.gen(function*() {
      // Arrange
      const answerFn = vi.fn(() => Effect.succeed(undefined))
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = makeQuestionPlanSession({ answerFn, events: Stream.fromQueue(planEventQueue) })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(queue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act — fork, process setup, then send plan question event
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(planEventQueue, questionEvent)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Custom answer", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Use approach C instead", from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert — prompt shown after tapping "Custom answer"
      expect(messengerMock.sendMessage).toHaveBeenCalledWith({
        text: "Type your answer:",
        options: [{ label: "Back" }]
      })
      // Free-text forwarded as the answer
      expect(answerFn).toHaveBeenCalledWith("Use approach C instead")
    }))

  it.effect("abort works while awaiting free-text answer", () =>
    Effect.gen(function*() {
      // Arrange
      const rejectFn = vi.fn(() => Effect.succeed(undefined))
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = makeQuestionPlanSession({ rejectFn, events: Stream.fromQueue(planEventQueue) })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(queue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(planEventQueue, questionEvent)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Custom answer", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert — abort still works, answer never forwarded
      expect(rejectFn).toHaveBeenCalled()
      expect(planSessionMock.answer).not.toHaveBeenCalled()
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Plan aborted.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }))

  it.effect("Back button re-shows original question options", () =>
    Effect.gen(function*() {
      // Arrange
      const answerFn = vi.fn(() => Effect.succeed(undefined))
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = makeQuestionPlanSession({ answerFn, events: Stream.fromQueue(planEventQueue) })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(queue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(planEventQueue, questionEvent)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Custom answer", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Back", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Option A", from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert — Back showed "Type your answer:" with Back button, then re-sent original question
      expect(messengerMock.sendMessage).toHaveBeenCalledWith({
        text: "Type your answer:",
        options: [{ label: "Back" }]
      })
      // Original question re-sent with options (called twice total — initial + after Back)
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.arrayContaining([{ label: "Option A" }, { label: "Option B" }])
        })
      )
      // Answer forwarded after going back and selecting Option A
      expect(answerFn).toHaveBeenCalledWith("Option A")
    }))

  it.effect("appends Custom answer button to question options", () =>
    Effect.gen(function*() {
      // Arrange
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = makeQuestionPlanSession({ events: Stream.fromQueue(planEventQueue) })
      const incomingQueue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(incomingQueue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(incomingQueue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act — process setup messages first, then send plan question
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(planEventQueue, questionEvent)
      yield* flush

      // Assert — question rendered with "Custom answer" appended
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            { label: "Option A" },
            { label: "Option B" },
            { label: "Custom answer" }
          ]
        })
      )
    }))

  it.effect("batches multiple question answers and sends them together", () =>
    Effect.gen(function*() {
      // Arrange
      const multiQuestionEvent = new PlanQuestion({
        questions: [
          { question: "Which DB?", header: "Database", options: [{ label: "Postgres" }, { label: "SQLite" }] },
          { question: "Which framework?", header: "Framework", options: [{ label: "Express" }, { label: "Fastify" }] }
        ]
      })
      const answerFn = vi.fn(() => Effect.succeed(undefined))
      const planEventQueue = yield* Queue.unbounded<PlanEvent>()
      const planSessionMock = PlanSession.of({
        start: vi.fn(() => Effect.succeed(undefined)),
        answer: answerFn,
        sendFollowUp: vi.fn(() => Effect.succeed(undefined)),
        interrupt: vi.fn(() => Effect.succeed(undefined)),
        approve: Effect.succeed(undefined),
        reject: Effect.succeed(undefined),
        isActive: Effect.succeed(false),
        isIdle: Effect.succeed(false),
        readFeatureAnalysis: readFailure,
        readBugAnalysis: readFailure,
        readRefactorAnalysis: readFailure,
        readDefaultAnalysis: readFailure,
        events: Stream.fromQueue(planEventQueue)
      })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Effect.forEach(planSetupMessages, (msg) => Queue.offer(queue, msg))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock })

      // Act — process setup, then send question event, then answer
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(planEventQueue, multiQuestionEvent)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Postgres", from: "user" }))
      yield* flush
      // After first answer, planSession.answer should NOT have been called yet
      expect(answerFn).not.toHaveBeenCalled()
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Fastify", from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert — answer called once with combined text
      expect(answerFn).toHaveBeenCalledTimes(1)
      expect(answerFn).toHaveBeenCalledWith("Postgres\nFastify")
    }))
})

describe("project selection", () => {
  it.effect("auto-selects single project and shows plan type", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const projectStoreMock = makeProjectStoreMock()
    const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert — shows plan type selection directly (auto-selected)
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "What type of change?",
          options: expect.arrayContaining([{ label: FEATURE_BUTTON_LABEL }])
        })
      )
      // No "Select a project:" message
      expect(messengerMock.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: "Select a project:" })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows project buttons when multiple projects exist", () => {
    // Arrange
    const projectA = new LalphProject({
      id: "project-a",
      enabled: true,
      targetBranch: Option.none(),
      concurrency: 1,
      gitFlow: "pr",
      reviewAgent: false
    })
    const projectB = new LalphProject({
      id: "project-b",
      enabled: true,
      targetBranch: Option.none(),
      concurrency: 1,
      gitFlow: "pr",
      reviewAgent: false
    })
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const projectStoreMock = makeProjectStoreMock({
      listProjects: Effect.succeed([projectA, projectB])
    })
    const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Select a project:",
          options: expect.arrayContaining([
            { label: "project-a" },
            { label: "project-b" },
            { label: NEW_PROJECT_BUTTON_LABEL },
            { label: ABORT_BUTTON_LABEL }
          ])
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("project selection leads to plan type selection", () =>
    Effect.gen(function*() {
      // Arrange
      const projectA = new LalphProject({
        id: "project-a",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const projectB = new LalphProject({
        id: "project-b",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" }))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const projectStoreMock = makeProjectStoreMock({
        listProjects: Effect.succeed([projectA, projectB])
      })
      const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "project-a", from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "What type of change?",
          options: expect.arrayContaining([{ label: FEATURE_BUTTON_LABEL }])
        })
      )
    }))

  it.effect("abort during project selection returns to idle", () =>
    Effect.gen(function*() {
      // Arrange
      const projectA = new LalphProject({
        id: "project-a",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const projectB = new LalphProject({
        id: "project-b",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" }))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const projectStoreMock = makeProjectStoreMock({
        listProjects: Effect.succeed([projectA, projectB])
      })
      const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Plan aborted.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }))

  it.effect("shows error when no projects exist", () => {
    // Arrange
    const incomingStream = Stream.fromIterable([
      new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" })
    ])
    const messengerMock = makeMessengerMock(incomingStream)
    const projectStoreMock = makeProjectStoreMock({
      listProjects: Effect.succeed([])
    })
    const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

    // Act
    return Effect.gen(function*() {
      yield* Effect.fork(runEventLoop)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("No projects. Create one first.")
    }).pipe(Effect.provide(layer))
  })

  it.effect("passes projectId to planSession.start when multiple projects", () =>
    Effect.gen(function*() {
      // Arrange
      const projectA = new LalphProject({
        id: "project-a",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const projectB = new LalphProject({
        id: "project-b",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const planSessionMock = makePlanSessionMock()
      const projectStoreMock = makeProjectStoreMock({
        listProjects: Effect.succeed([projectA, projectB])
      })
      const { layer } = makeTestLayer([], { messengerMock, planSessionMock, projectStoreMock })

      // Act — fork first, then send messages with flushes
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "project-a", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: FEATURE_BUTTON_LABEL, from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "my plan", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Done", from: "user" }))
      yield* flush

      // Assert — projectId passed since >1 projects
      expect(planSessionMock.start).toHaveBeenCalledWith("my plan", "project-a", "lalph")
    }))
})

describe("project creation wizard", () => {
  it.effect("creates project through full wizard flow", () =>
    Effect.gen(function*() {
      // Arrange
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: NEW_PROJECT_BUTTON_LABEL, from: "user" }))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const projectStoreMock = makeProjectStoreMock()
      const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      // Name
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "my-project", from: "user" }))
      yield* flush
      // Concurrency
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "2", from: "user" }))
      yield* flush
      // TargetBranch
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "main", from: "user" }))
      yield* flush
      // GitFlow
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "PR", from: "user" }))
      yield* flush
      // ReviewAgent
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Yes", from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith("Enter project name:")
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Concurrency (tasks in parallel):" })
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Target branch (type branch name or skip):" })
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Git flow:" })
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Enable review agent?" })
      )
      expect(projectStoreMock.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "my-project",
          concurrency: 2,
          gitFlow: "pr",
          reviewAgent: true
        })
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "Project <b>my-project</b> created."
      )
    }))

  it.effect("abort during wizard returns to idle", () =>
    Effect.gen(function*() {
      // Arrange
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: NEW_PROJECT_BUTTON_LABEL, from: "user" }))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const { layer } = makeTestLayer([], { messengerMock })

      // Act
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      // Enter name step, then abort
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: ABORT_BUTTON_LABEL, from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Project creation cancelled.",
          replyKeyboard: expect.arrayContaining([{ label: PLAN_BUTTON_LABEL }])
        })
      )
    }))

  it.effect("new project from SelectingProject continues to plan", () =>
    Effect.gen(function*() {
      // Arrange
      const projectA = new LalphProject({
        id: "project-a",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const projectB = new LalphProject({
        id: "project-b",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        reviewAgent: false
      })
      const queue = yield* Queue.unbounded<IncomingMessage>()
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: PLAN_BUTTON_LABEL, from: "user" }))
      const messengerMock = makeMessengerMock(Stream.fromQueue(queue))
      const projectStoreMock = makeProjectStoreMock({
        listProjects: Effect.succeed([projectA, projectB])
      })
      const { layer } = makeTestLayer([], { messengerMock, projectStoreMock })

      // Act — select "New project" from project list
      yield* runEventLoop.pipe(Effect.provide(layer), Effect.fork)
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: NEW_PROJECT_BUTTON_LABEL, from: "user" }))
      yield* flush
      // Wizard: Name → Concurrency → TargetBranch → GitFlow → ReviewAgent
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "new-proj", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "1", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Skip", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "Commit", from: "user" }))
      yield* flush
      yield* Queue.offer(queue, new IncomingMessage({ chatId: "1", text: "No", from: "user" }))
      yield* Queue.shutdown(queue)
      yield* flush

      // Assert — after wizard, continues to plan type selection
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        "Project <b>new-proj</b> created."
      )
      expect(messengerMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "What type of change?",
          options: expect.arrayContaining([{ label: FEATURE_BUTTON_LABEL }])
        })
      )
    }))
})
