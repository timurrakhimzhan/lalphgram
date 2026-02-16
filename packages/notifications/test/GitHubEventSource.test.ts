import { describe, expect, it, vi } from "@effect/vitest"
import { Chunk, Duration, Effect, Fiber, Layer, Ref, Stream } from "effect"
import type { AppEvent } from "../src/Events.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/schemas/CredentialSchemas.js"
import { GitHubComment, GitHubPullRequest, GitHubRepo } from "../src/schemas/GitHubSchemas.js"
import { GitHubClient, GitHubClientError } from "../src/services/GitHubClient.js"
import { GitHubEventSource, GitHubEventSourceLive } from "../src/services/GitHubEventSource.js"
import { TrackerResolver } from "../src/services/TrackerResolver.js"

const testRepo = new GitHubRepo({
  id: 1,
  name: "my-repo",
  full_name: "owner/my-repo",
  owner: { login: "owner" },
  html_url: "https://github.com/owner/my-repo"
})

const testRepo2 = new GitHubRepo({
  id: 2,
  name: "other-repo",
  full_name: "owner/other-repo",
  owner: { login: "owner" },
  html_url: "https://github.com/owner/other-repo"
})

const makePR = (overrides: Partial<{
  id: number
  number: number
  title: string
  headRef: string
  hasConflicts: boolean
  repo: string
}> = {}) =>
  new GitHubPullRequest({
    id: overrides.id ?? 100,
    number: overrides.number ?? 1,
    title: overrides.title ?? "Test PR",
    state: "open",
    html_url: "https://github.com/owner/my-repo/pull/1",
    headRef: overrides.headRef ?? "feature/test",
    hasConflicts: overrides.hasConflicts ?? false,
    repo: overrides.repo ?? "owner/my-repo"
  })

const makeComment = (overrides: Partial<{
  id: number
  body: string
  login: string
  repo: string
}> = {}) =>
  new GitHubComment({
    id: overrides.id ?? 1,
    body: overrides.body ?? "Some comment",
    user: { login: overrides.login ?? "reviewer" },
    created_at: "2024-01-15T10:00:00Z",
    html_url: "https://github.com/owner/my-repo/pull/1#issuecomment-1",
    repo: overrides.repo ?? "owner/my-repo"
  })

const runtimeConfig = new RuntimeConfig({
  pollIntervalSeconds: 0.001,
  triggerKeyword: "urgent",
  timerDelaySeconds: 300
})

const runtimeConfigLayer = Layer.succeed(AppRuntimeConfig, runtimeConfig)

const makeGitHubClientMock = (overrides: Partial<{
  getAuthenticatedUser: () => Effect.Effect<{ readonly login: string }, GitHubClientError>
  listUserRepos: () => Effect.Effect<ReadonlyArray<GitHubRepo>, GitHubClientError>
  listOpenPRs: (repo: GitHubRepo) => Effect.Effect<ReadonlyArray<GitHubPullRequest>, GitHubClientError>
  listComments: (repo: GitHubRepo, prNumber: number) => Effect.Effect<ReadonlyArray<GitHubComment>, GitHubClientError>
  listReviewComments: (
    repo: GitHubRepo,
    prNumber: number
  ) => Effect.Effect<ReadonlyArray<GitHubComment>, GitHubClientError>
}> = {}) =>
  GitHubClient.of({
    getAuthenticatedUser: overrides.getAuthenticatedUser ?? vi.fn(() => Effect.succeed({ login: "me" })),
    listUserRepos: overrides.listUserRepos ?? vi.fn(() => Effect.succeed([testRepo])),
    listOpenPRs: overrides.listOpenPRs ?? vi.fn(() => Effect.succeed([])),
    getPR: vi.fn(() => Effect.succeed(makePR())),
    postComment: vi.fn(() => Effect.succeed(undefined)),
    listComments: overrides.listComments ?? vi.fn(() => Effect.succeed([])),
    listReviewComments: overrides.listReviewComments ?? vi.fn(() => Effect.succeed([]))
  })

const makeTrackerResolverMock = (watchedRepos: ReadonlyArray<string> = []) =>
  TrackerResolver.of({
    trackerForRepo: vi.fn(() =>
      Effect.succeed({
        getRecentEvents: vi.fn(() => Effect.succeed([])),
        moveToTodo: vi.fn(() => Effect.succeed(undefined)),
        setPriorityUrgent: vi.fn(() => Effect.succeed(undefined)),
        getIssue: vi.fn(() =>
          Effect.succeed({
            id: "ISSUE-1",
            title: "Test Issue",
            state: "In Progress",
            url: "https://example.com",
            createdAt: "2024-01-15T10:00:00Z",
            updatedAt: "2024-01-15T10:00:00Z"
          })
        )
      })
    ),
    allTrackers: [],
    allWatchedRepos: [...watchedRepos]
  })

const makeTestLayer = (
  mock: ReturnType<typeof makeGitHubClientMock>,
  watchedRepos: ReadonlyArray<string> = []
) =>
  GitHubEventSourceLive.pipe(
    Layer.provide(Layer.succeed(GitHubClient, mock)),
    Layer.provide(runtimeConfigLayer),
    Layer.provide(Layer.succeed(TrackerResolver, makeTrackerResolverMock(watchedRepos)))
  )

const takeEvents = (n: number) =>
  Effect.gen(function*() {
    const source = yield* GitHubEventSource
    return yield* source.stream.pipe(
      Stream.take(n),
      Stream.runCollect,
      Effect.map(Chunk.toArray)
    )
  })

const collectEventsFor = (ms: number) =>
  Effect.gen(function*() {
    const source = yield* GitHubEventSource
    const collected = yield* Ref.make<Array<AppEvent>>([])
    const fiber = yield* source.stream.pipe(
      Stream.runForEach((event) => Ref.update(collected, (arr) => [...arr, event])),
      Effect.fork
    )
    yield* Effect.sleep(Duration.millis(ms))
    yield* Fiber.interrupt(fiber)
    return yield* Ref.get(collected)
  })

const getPRFromEvent = (event: AppEvent | undefined) => {
  if (event && "pr" in event) return event.pr
  return undefined
}

const getCommentFromEvent = (event: AppEvent | undefined) => {
  if (event && "comment" in event) return event.comment
  return undefined
}

describe("GitHubEventSource", () => {
  it.live("first cycle populates known PRs without emitting PROpened", () => {
    // Arrange
    const pr = makePR({ id: 100 })
    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr]))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        expect(events.filter((e) => e._tag === "PROpened")).toHaveLength(0)
        expect(mock.listOpenPRs).toHaveBeenCalled()
      })
    )
  })

  it.live("emits PRConflictDetected on first cycle for conflicted PRs", () => {
    // Arrange
    const conflictedPR = makePR({ id: 101, hasConflicts: true })
    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([conflictedPR]))
    })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]?._tag).toBe("PRConflictDetected")
        expect(getPRFromEvent(events[0])?.id).toBe(101)
      })
    )
  })

  it.live("emits PROpened on second cycle for new PRs", () => {
    // Arrange
    let callCount = 0
    const pr1 = makePR({ id: 100 })
    const pr2 = makePR({ id: 200, number: 2, title: "New PR" })
    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => {
        callCount++
        if (callCount === 1) return Effect.succeed([pr1])
        return Effect.succeed([pr1, pr2])
      })
    })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]?._tag).toBe("PROpened")
        expect(getPRFromEvent(events[0])?.id).toBe(200)
      })
    )
  })

  it.live("does not emit PROpened for already known PRs on second cycle", () => {
    // Arrange
    const pr1 = makePR({ id: 100 })
    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr1]))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        expect(events.filter((e) => e._tag === "PROpened")).toHaveLength(0)
      })
    )
  })

  it.live("emits PRConflictDetected only once for persistently conflicted PR", () => {
    // Arrange
    const conflictedPR = makePR({ id: 101, hasConflicts: true })
    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([conflictedPR]))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        const conflictEvents = events.filter((e) => e._tag === "PRConflictDetected")
        expect(conflictEvents).toHaveLength(1)
        expect(getPRFromEvent(conflictEvents[0])?.id).toBe(101)
      })
    )
  })

  it.live("filters out comments from non-authenticated users", () => {
    // Arrange
    let listCommentsCallCount = 0
    const pr = makePR({ id: 100 })
    const myComment = makeComment({ id: 10, login: "me", body: "My own comment" })
    const otherComment = makeComment({ id: 11, login: "reviewer", body: "Review" })

    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr])),
      listComments: vi.fn(() => {
        listCommentsCallCount++
        if (listCommentsCallCount === 1) return Effect.succeed([])
        return Effect.succeed([myComment, otherComment])
      })
    })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        const commentEvents = events.filter((e) => e._tag === "PRCommentAdded")
        expect(commentEvents).toHaveLength(1)
        expect(getCommentFromEvent(commentEvents[0])?.user.login).toBe("me")
      })
    )
  })

  it.live("emits PRCommentAdded on second cycle for new comments", () => {
    // Arrange
    let listCommentsCallCount = 0
    const pr = makePR({ id: 100 })
    const comment1 = makeComment({ id: 10, login: "me", body: "First comment" })
    const comment2 = makeComment({ id: 20, login: "me", body: "Second comment" })

    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr])),
      listComments: vi.fn(() => {
        listCommentsCallCount++
        if (listCommentsCallCount === 1) return Effect.succeed([comment1])
        return Effect.succeed([comment1, comment2])
      })
    })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        const commentEvents = events.filter((e) => e._tag === "PRCommentAdded")
        expect(commentEvents).toHaveLength(1)
        expect(getCommentFromEvent(commentEvents[0])?.id).toBe(20)
      })
    )
  })

  it.live("does not emit PRCommentAdded on first cycle", () => {
    // Arrange
    const pr = makePR({ id: 100 })
    const comment = makeComment({ id: 10 })

    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr])),
      listComments: vi.fn(() => Effect.succeed([comment]))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        expect(events.filter((e) => e._tag === "PRCommentAdded")).toHaveLength(0)
      })
    )
  })

  it.live("emits PRCommentAdded for new review comments", () => {
    // Arrange
    let listReviewCommentsCallCount = 0
    const pr = makePR({ id: 100 })
    const reviewComment = makeComment({ id: 50, login: "me", body: "Review feedback" })

    const mock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr])),
      listReviewComments: vi.fn(() => {
        listReviewCommentsCallCount++
        if (listReviewCommentsCallCount === 1) return Effect.succeed([])
        return Effect.succeed([reviewComment])
      })
    })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        const commentEvents = events.filter((e) => e._tag === "PRCommentAdded")
        expect(commentEvents).toHaveLength(1)
        expect(getCommentFromEvent(commentEvents[0])?.id).toBe(50)
        expect(getCommentFromEvent(commentEvents[0])?.body).toBe("Review feedback")
      })
    )
  })

  it.live("handles poll cycle errors by logging and emitting empty batch", () => {
    // Arrange
    const mock = makeGitHubClientMock({
      listUserRepos: vi.fn(() => Effect.fail(new GitHubClientError({ message: "API rate limited", cause: null })))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(mock.listUserRepos).toHaveBeenCalled()
      })
    )
  })

  it.live("filters repos when watchedRepos is specified", () => {
    // Arrange
    const pr1 = makePR({ id: 100, repo: "owner/my-repo" })
    const pr2 = makePR({ id: 200, number: 2, repo: "owner/other-repo" })
    const mock = makeGitHubClientMock({
      listUserRepos: vi.fn(() => Effect.succeed([testRepo, testRepo2])),
      listOpenPRs: vi.fn((repo: GitHubRepo) => {
        if (repo.full_name === "owner/my-repo") return Effect.succeed([pr1])
        if (repo.full_name === "owner/other-repo") return Effect.succeed([pr2])
        return Effect.succeed([])
      })
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock, ["owner/my-repo"])),
      Effect.map((_events) => {
        // Assert
        expect(mock.listOpenPRs).toHaveBeenCalledWith(
          expect.objectContaining({ full_name: "owner/my-repo" })
        )
        expect(mock.listOpenPRs).not.toHaveBeenCalledWith(
          expect.objectContaining({ full_name: "owner/other-repo" })
        )
      })
    )
  })

  it.live("watches all repos when watchedRepos is empty", () => {
    // Arrange
    const pr1 = makePR({ id: 100, repo: "owner/my-repo" })
    const pr2 = makePR({ id: 200, number: 2, repo: "owner/other-repo" })
    const mock = makeGitHubClientMock({
      listUserRepos: vi.fn(() => Effect.succeed([testRepo, testRepo2])),
      listOpenPRs: vi.fn((repo: GitHubRepo) => {
        if (repo.full_name === "owner/my-repo") return Effect.succeed([pr1])
        if (repo.full_name === "owner/other-repo") return Effect.succeed([pr2])
        return Effect.succeed([])
      })
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(mock, [])),
      Effect.map((_events) => {
        // Assert
        expect(mock.listOpenPRs).toHaveBeenCalledWith(
          expect.objectContaining({ full_name: "owner/my-repo" })
        )
        expect(mock.listOpenPRs).toHaveBeenCalledWith(
          expect.objectContaining({ full_name: "owner/other-repo" })
        )
      })
    )
  })
})
