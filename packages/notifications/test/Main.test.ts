import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { PRCommentAdded, PRConflictDetected, PROpened, TaskCreated, TaskUpdated } from "../src/Events.js"
import type { AppEvent } from "../src/Events.js"
import { BranchParserLive } from "../src/lib/BranchParser.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/schemas/CredentialSchemas.js"
import { GitHubComment, GitHubPullRequest } from "../src/schemas/GitHubSchemas.js"
import { TrackerIssue } from "../src/schemas/TrackerSchemas.js"
import { CommentTimer } from "../src/services/CommentTimer.js"
import { runEventLoop } from "../src/services/EventLoop.js"
import { GitHubClient } from "../src/services/GitHubClient.js"
import { GitHubEventSource } from "../src/services/GitHubEventSource.js"
import type { GitHubEventSourceError } from "../src/services/GitHubEventSource.js"
import { MessengerAdapter, MessengerAdapterError } from "../src/services/MessengerAdapter.js"
import { TaskEventSource } from "../src/services/TaskEventSource.js"
import type { TaskEventSourceError } from "../src/services/TaskEventSource.js"
import { TaskTracker } from "../src/services/TaskTracker.js"
import type { TaskTrackerService } from "../src/services/TaskTracker.js"

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

const makeEventSourcesFromEvents = (events: ReadonlyArray<AppEvent>) => {
  const githubStream: Stream.Stream<AppEvent, GitHubEventSourceError> = Stream.fromIterable(events)
  const taskStream: Stream.Stream<AppEvent, TaskEventSourceError> = Stream.empty

  return {
    githubEventSourceMock: GitHubEventSource.of({
      stream: githubStream
    }),
    taskEventSourceMock: TaskEventSource.of({
      stream: taskStream
    })
  }
}

const makeMessengerMock = () =>
  MessengerAdapter.of({
    sendMessage: vi.fn(() => Effect.succeed(undefined)),
    incomingMessages: Stream.empty
  })

const makeGitHubClientMock = () =>
  GitHubClient.of({
    getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "test-user" })),
    listUserRepos: vi.fn(() => Effect.succeed([])),
    listOpenPRs: vi.fn(() => Effect.succeed([])),
    getPR: vi.fn(() => Effect.succeed(makePR())),
    postComment: vi.fn(() => Effect.succeed(undefined)),
    listComments: vi.fn(() => Effect.succeed([])),
    listReviewComments: vi.fn(() => Effect.succeed([]))
  })

const makeTrackerMock = (): TaskTrackerService => ({
  getRecentEvents: vi.fn(() => Effect.succeed([])),
  moveToTodo: vi.fn(() => Effect.succeed(undefined)),
  setPriorityUrgent: vi.fn(() => Effect.succeed(undefined)),
  getIssue: vi.fn(() => Effect.succeed(makeIssue()))
})

const makeCommentTimerMock = () =>
  CommentTimer.of({
    handleComment: vi.fn(() => Effect.succeed(undefined)),
    shutdown: Effect.succeed(undefined)
  })

const makeTestLayer = (
  events: ReadonlyArray<AppEvent>,
  overrides: {
    messengerMock?: ReturnType<typeof makeMessengerMock>
    githubClientMock?: ReturnType<typeof makeGitHubClientMock>
    trackerMock?: TaskTrackerService
    commentTimerMock?: ReturnType<typeof makeCommentTimerMock>
  } = {}
) => {
  const { githubEventSourceMock, taskEventSourceMock } = makeEventSourcesFromEvents(events)
  const messengerMock = overrides.messengerMock ?? makeMessengerMock()
  const githubClientMock = overrides.githubClientMock ?? makeGitHubClientMock()
  const trackerMock = overrides.trackerMock ?? makeTrackerMock()
  const commentTimerMock = overrides.commentTimerMock ?? makeCommentTimerMock()

  return {
    layer: Layer.mergeAll(
      Layer.succeed(GitHubEventSource, githubEventSourceMock),
      Layer.succeed(TaskEventSource, taskEventSourceMock),
      Layer.succeed(MessengerAdapter, messengerMock),
      Layer.succeed(GitHubClient, githubClientMock),
      Layer.succeed(TaskTracker, trackerMock),
      Layer.succeed(CommentTimer, commentTimerMock),
      Layer.succeed(AppRuntimeConfig, testRuntimeConfig),
      BranchParserLive
    ),
    messengerMock,
    githubClientMock,
    trackerMock,
    commentTimerMock
  }
}

describe("event loop dispatch", () => {
  it.effect("sends Telegram notification for TaskCreated events", () => {
    // Arrange
    const event = new TaskCreated({ issue: makeIssue() })
    const { layer, messengerMock } = makeTestLayer([event])

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
    const { layer, messengerMock } = makeTestLayer([event])

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

  it.effect("catches dispatch errors and continues processing", () => {
    // Arrange
    const event1 = new TaskCreated({ issue: makeIssue() })
    const event2 = new PROpened({ pr: makePR() })
    const callCount = { value: 0 }
    const messengerMock = MessengerAdapter.of({
      sendMessage: vi.fn(() => {
        callCount.value++
        if (callCount.value === 1) {
          return Effect.fail(new MessengerAdapterError({ message: "API error", cause: null }))
        }
        return Effect.succeed(undefined)
      }),
      incomingMessages: Stream.empty
    })
    const { layer } = makeTestLayer([event1, event2], { messengerMock })

    // Act & Assert
    return Effect.gen(function*() {
      yield* runEventLoop

      // Both events were processed even though the first one failed
      expect(messengerMock.sendMessage).toHaveBeenCalledTimes(2)
    }).pipe(Effect.provide(layer))
  })
})
