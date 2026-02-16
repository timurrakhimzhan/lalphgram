import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { PRAutoMerged, PRCIFailed } from "../src/Events.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/schemas/CredentialSchemas.js"
import { GitHubPullRequest } from "../src/schemas/GitHubSchemas.js"
import { AutoMerge, AutoMergeLive } from "../src/services/AutoMerge.js"
import type { GitHubCIStatus, GitHubClientService } from "../src/services/GitHubClient.js"
import { GitHubClient, GitHubClientError } from "../src/services/GitHubClient.js"

const makePR = (overrides: Partial<{
  id: number
  number: number
  title: string
  headRef: string
  headSha: string
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
    headSha: overrides.headSha ?? "abc123",
    hasConflicts: overrides.hasConflicts ?? false,
    repo: overrides.repo ?? "owner/my-repo"
  })

const makeRuntimeConfig = (overrides: Partial<{
  autoMergeEnabled: boolean
  autoMergeWaitMinutes: number
}> = {}) =>
  new RuntimeConfig({
    pollIntervalSeconds: 30,
    triggerKeyword: "urgent",
    timerDelaySeconds: 300,
    autoMergeEnabled: overrides.autoMergeEnabled ?? true,
    autoMergeWaitMinutes: overrides.autoMergeWaitMinutes ?? 0
  })

const makeGitHubClientMock = (overrides: Partial<GitHubClientService> = {}): GitHubClientService =>
  GitHubClient.of({
    getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "bot" })),
    listUserRepos: vi.fn(() => Effect.succeed([])),
    listOpenPRs: vi.fn(() => Effect.succeed([])),
    getPR: vi.fn(() => Effect.succeed(makePR())),
    postComment: vi.fn(() => Effect.succeed(undefined)),
    listComments: vi.fn(() => Effect.succeed([])),
    listReviewComments: vi.fn(() => Effect.succeed([])),
    getCIStatus: vi.fn(() => Effect.succeed({ state: "success", checkRuns: [] })),
    mergePR: vi.fn(() => Effect.succeed(undefined)),
    ...overrides
  })

const makeTestLayer = (
  githubMock: GitHubClientService,
  runtimeConfig: RuntimeConfig = makeRuntimeConfig()
) =>
  AutoMergeLive.pipe(
    Layer.provide(Layer.succeed(GitHubClient, githubMock)),
    Layer.provide(Layer.succeed(AppRuntimeConfig, runtimeConfig))
  )

describe("AutoMerge", () => {
  it.effect("skips evaluation when auto-merge disabled", () => {
    // Arrange
    const githubMock = makeGitHubClientMock()
    const config = makeRuntimeConfig({ autoMergeEnabled: false })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge

      // Act
      const events = yield* autoMerge.evaluatePRs([makePR()])

      // Assert
      expect(events).toHaveLength(0)
      expect(githubMock.getCIStatus).not.toHaveBeenCalled()
    }).pipe(Effect.provide(makeTestLayer(githubMock, config)))
  })

  it.effect("merges PR when CI passes and wait time elapsed", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{ id: 1, name: "build", status: "completed", conclusion: "success", html_url: "" }]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR()

      // Act
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert
      expect(events).toHaveLength(1)
      expect(events[0]).toBeInstanceOf(PRAutoMerged)
      expect(githubMock.mergePR).toHaveBeenCalled()
    }).pipe(Effect.provide(makeTestLayer(githubMock, config)))
  })

  it.effect("does not merge when wait time not yet elapsed", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{ id: 1, name: "build", status: "completed", conclusion: "success", html_url: "" }]
        })
      )
    })
    // Wait 60 minutes — will never elapse in test
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 60 })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR()

      // Act
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert
      expect(events).toHaveLength(0)
      expect(githubMock.mergePR).not.toHaveBeenCalled()
    }).pipe(Effect.provide(makeTestLayer(githubMock, config)))
  })

  it.effect("posts failure comment when CI fails", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "failure",
          checkRuns: [
            { id: 1, name: "build", status: "completed", conclusion: "failure", html_url: "https://example.com/run/1" },
            { id: 2, name: "lint", status: "completed", conclusion: "success", html_url: "" }
          ]
        })
      ),
      postComment: vi.fn(() => Effect.succeed(undefined))
    })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR()

      // Act
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert
      expect(events).toHaveLength(1)
      expect(events[0]).toBeInstanceOf(PRCIFailed)
      expect(githubMock.postComment).toHaveBeenCalledWith(
        expect.objectContaining({ full_name: "owner/my-repo" }),
        1,
        expect.stringContaining("build: failure")
      )
    }).pipe(Effect.provide(makeTestLayer(githubMock)))
  })

  it.effect("does not duplicate failure comment for same SHA", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "failure",
          checkRuns: [
            { id: 1, name: "build", status: "completed", conclusion: "failure", html_url: "" }
          ]
        })
      ),
      postComment: vi.fn(() => Effect.succeed(undefined))
    })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR({ headSha: "same-sha" })

      // Act — evaluate twice with the same SHA
      yield* autoMerge.evaluatePRs([pr])
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert — second call should not post a comment or emit an event
      expect(events).toHaveLength(0)
      expect(githubMock.postComment).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(makeTestLayer(githubMock)))
  })

  it.effect("resets failure tracking when SHA changes", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "failure",
          checkRuns: [
            { id: 1, name: "build", status: "completed", conclusion: "failure", html_url: "" }
          ]
        })
      ),
      postComment: vi.fn(() => Effect.succeed(undefined))
    })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr1 = makePR({ headSha: "sha-1" })
      const pr2 = makePR({ headSha: "sha-2" })

      // Act — first evaluation with sha-1
      yield* autoMerge.evaluatePRs([pr1])
      // Second evaluation with sha-2 (new push)
      const events = yield* autoMerge.evaluatePRs([pr2])

      // Assert — should post a new comment and emit event for the new SHA
      expect(events).toHaveLength(1)
      expect(events[0]).toBeInstanceOf(PRCIFailed)
      expect(githubMock.postComment).toHaveBeenCalledTimes(2)
    }).pipe(Effect.provide(makeTestLayer(githubMock)))
  })

  it.effect("skips PRs with merge conflicts", () => {
    // Arrange
    const githubMock = makeGitHubClientMock()

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR({ hasConflicts: true })

      // Act
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert
      expect(events).toHaveLength(0)
      expect(githubMock.getCIStatus).not.toHaveBeenCalled()
    }).pipe(Effect.provide(makeTestLayer(githubMock)))
  })

  it.effect("skips already-merged PRs", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{ id: 1, name: "build", status: "completed", conclusion: "success", html_url: "" }]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR()

      // Act — first evaluation merges, second should skip
      const firstEvents = yield* autoMerge.evaluatePRs([pr])
      const secondEvents = yield* autoMerge.evaluatePRs([pr])

      // Assert
      expect(firstEvents).toHaveLength(1)
      expect(firstEvents[0]).toBeInstanceOf(PRAutoMerged)
      expect(secondEvents).toHaveLength(0)
      expect(githubMock.mergePR).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(makeTestLayer(githubMock, config)))
  })

  it.effect("handles merge API failure gracefully", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{ id: 1, name: "build", status: "completed", conclusion: "success", html_url: "" }]
        })
      ),
      mergePR: vi.fn(() => Effect.fail(new GitHubClientError({ message: "Merge conflict", cause: null })))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR()

      // Act — merge fails but should not throw
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert — no events emitted since merge failed
      expect(events).toHaveLength(0)
      expect(githubMock.mergePR).toHaveBeenCalled()
    }).pipe(Effect.provide(makeTestLayer(githubMock, config)))
  })

  it.effect("handles CI status fetch failure gracefully", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() => Effect.fail(new GitHubClientError({ message: "API rate limited", cause: null })))
    })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR()

      // Act — CI status fetch fails but should not throw
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert
      expect(events).toHaveLength(0)
    }).pipe(Effect.provide(makeTestLayer(githubMock)))
  })

  it.effect("cleans up state for PRs no longer open", () => {
    // Arrange
    let callCount = 0
    const ciStatusResults: ReadonlyArray<GitHubCIStatus> = [
      { state: "pending", checkRuns: [] },
      {
        state: "success",
        checkRuns: [{ id: 1, name: "build", status: "completed", conclusion: "success", html_url: "" }]
      }
    ]
    const githubMock = makeGitHubClientMock({
      getCIStatus: vi.fn(() => {
        const result = ciStatusResults[callCount] ?? { state: "success", checkRuns: [] }
        callCount++
        return Effect.succeed(result)
      }),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    return Effect.gen(function*() {
      const autoMerge = yield* AutoMerge
      const pr = makePR({ number: 1 })

      // Act — first evaluation with the PR present (pending CI)
      yield* autoMerge.evaluatePRs([pr])
      // Second evaluation without the PR (PR closed/removed)
      yield* autoMerge.evaluatePRs([])
      // Third evaluation with a new PR with same number (state should have been cleaned up)
      const events = yield* autoMerge.evaluatePRs([pr])

      // Assert — PR should be treated as new (no stale state)
      expect(events).toHaveLength(1)
      expect(events[0]).toBeInstanceOf(PRAutoMerged)
    }).pipe(Effect.provide(makeTestLayer(githubMock, config)))
  })
})
