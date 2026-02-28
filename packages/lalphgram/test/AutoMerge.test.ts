import { describe, expect, it, vi } from "@effect/vitest"
import { Chunk, Duration, Effect, Fiber, Layer, Ref, Stream } from "effect"
import type { AutoMergeEvent } from "../src/Events.js"
import { PRAutoMerged } from "../src/Events.js"
import { GitHubPullRequest, GitHubRepo } from "../src/schemas/GitHubSchemas.js"
import { AppRuntimeConfig, RuntimeConfig } from "../src/services/AppRuntimeConfig.js"
import { AutoMerge, AutoMergeLive } from "../src/services/AutoMerge.js"
import type { GitHubClientService } from "../src/services/GitHubClient.js"
import { GitHubClient, GitHubClientError } from "../src/services/GitHubClient.js"
import { LalphConfig } from "../src/services/LalphConfig.js"

const testRepo = new GitHubRepo({
  id: 1,
  name: "my-repo",
  full_name: "owner/my-repo",
  owner: { login: "owner" },
  html_url: "https://github.com/owner/my-repo"
})

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
    pollIntervalSeconds: 0.001,
    triggerKeyword: "urgent",
    timerDelaySeconds: 300,
    autoMergeEnabled: overrides.autoMergeEnabled ?? true,
    autoMergeWaitMinutes: overrides.autoMergeWaitMinutes ?? 0
  })

const makeLalphConfigMock = () =>
  LalphConfig.of({
    githubToken: Effect.succeed("test-token"),
    linearToken: Effect.succeed("test-linear-token"),
    issueSource: "github",
    specUploader: "telegraph",
    repoFullName: "owner/my-repo",
    linearProjectIds: []
  })

const makeGitHubClientMock = (overrides: Partial<GitHubClientService> = {}): GitHubClientService =>
  GitHubClient.of({
    getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "bot" })),
    listUserRepos: vi.fn(() => Effect.succeed([testRepo])),
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
    Layer.provide(Layer.succeed(AppRuntimeConfig, runtimeConfig)),
    Layer.provide(Layer.succeed(LalphConfig, makeLalphConfigMock()))
  )

const takeEvents = (n: number) =>
  Effect.gen(function*() {
    const autoMerge = yield* AutoMerge
    return yield* autoMerge.eventStream.pipe(
      Stream.take(n),
      Stream.runCollect,
      Effect.map(Chunk.toArray)
    )
  })

const collectEventsFor = (ms: number) =>
  Effect.gen(function*() {
    const autoMerge = yield* AutoMerge
    const collected = yield* Ref.make<Array<AutoMergeEvent>>([])
    const fiber = yield* autoMerge.eventStream.pipe(
      Stream.runForEach((event) => Ref.update(collected, (arr) => [...arr, event])),
      Effect.fork
    )
    yield* Effect.sleep(Duration.millis(ms))
    yield* Fiber.interrupt(fiber)
    return yield* Ref.get(collected)
  })

describe("AutoMerge", () => {
  it.live("skips evaluation when auto-merge disabled", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()]))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: false })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(githubMock.getCIStatus).not.toHaveBeenCalled()
      })
    )
  })

  it.live("merges PR when CI passes and wait time elapsed", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "",
            output: null,
            annotationMessages: []
          }]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]).toBeInstanceOf(PRAutoMerged)
        expect(githubMock.mergePR).toHaveBeenCalled()
      })
    )
  })

  it.live("does not merge when wait time not yet elapsed", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "",
            output: null,
            annotationMessages: []
          }]
        })
      )
    })
    // Wait 60 minutes — will never elapse in test
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 60 })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(githubMock.mergePR).not.toHaveBeenCalled()
      })
    )
  })

  it.live("skips PRs with merge conflicts", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR({ hasConflicts: true })]))
    })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(githubMock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(githubMock.getCIStatus).not.toHaveBeenCalled()
      })
    )
  })

  it.live("skips already-merged PRs", () => {
    // Arrange
    const pr = makePR()
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([pr])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "",
            output: null,
            annotationMessages: []
          }]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act — take 1 event (the first merge), then collect for a while to confirm no second merge
    return takeEvents(1).pipe(
      Effect.flatMap(() => collectEventsFor(50)),
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(githubMock.mergePR).toHaveBeenCalledTimes(1)
      })
    )
  })

  it.live("handles merge API failure gracefully", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "success",
          checkRuns: [{
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "",
            output: null,
            annotationMessages: []
          }]
        })
      ),
      mergePR: vi.fn(() => Effect.fail(new GitHubClientError({ message: "Merge conflict", cause: null })))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act — merge fails but should not throw
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert — no events emitted since merge failed
        expect(events).toHaveLength(0)
        expect(githubMock.mergePR).toHaveBeenCalled()
      })
    )
  })

  it.live("handles CI status fetch failure gracefully", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() => Effect.fail(new GitHubClientError({ message: "API rate limited", cause: null })))
    })

    // Act — CI status fetch fails but should not throw
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(githubMock)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
      })
    )
  })

  it.live("merges PR when no CI checks are configured", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() => Effect.succeed({ state: "pending", checkRuns: [] })),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]).toBeInstanceOf(PRAutoMerged)
        expect(githubMock.mergePR).toHaveBeenCalled()
      })
    )
  })

  it.live("merges PR when all checks are billing failures", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "failure",
          checkRuns: [{
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "failure",
            html_url: "",
            output: null,
            annotationMessages: [
              "The job was not started because recent account payments have failed or your spending limit needs to be increased."
            ]
          }]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]).toBeInstanceOf(PRAutoMerged)
        expect(githubMock.mergePR).toHaveBeenCalled()
      })
    )
  })

  it.live("does not merge when billing failure mixed with real CI failure", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "failure",
          checkRuns: [
            {
              id: 1,
              name: "build",
              status: "completed",
              conclusion: "failure",
              html_url: "",
              output: null,
              annotationMessages: [
                "The job was not started because recent account payments have failed or your spending limit needs to be increased."
              ]
            },
            {
              id: 2,
              name: "lint",
              status: "completed",
              conclusion: "failure",
              html_url: "",
              output: { title: "Lint failed", summary: "Found 3 errors" },
              annotationMessages: []
            }
          ]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act
    return collectEventsFor(50).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(0)
        expect(githubMock.mergePR).not.toHaveBeenCalled()
      })
    )
  })

  it.live("merges PR when billing failures mixed with passing checks", () => {
    // Arrange
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => Effect.succeed([makePR()])),
      getCIStatus: vi.fn(() =>
        Effect.succeed({
          state: "failure",
          checkRuns: [
            {
              id: 1,
              name: "build",
              status: "completed",
              conclusion: "failure",
              html_url: "",
              output: null,
              annotationMessages: [
                "The job was not started because recent account payments have failed or your spending limit needs to be increased."
              ]
            },
            {
              id: 2,
              name: "lint",
              status: "completed",
              conclusion: "success",
              html_url: "",
              output: null,
              annotationMessages: []
            }
          ]
        })
      ),
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert
        expect(events).toHaveLength(1)
        expect(events[0]).toBeInstanceOf(PRAutoMerged)
        expect(githubMock.mergePR).toHaveBeenCalled()
      })
    )
  })

  it.live("cleans up state for PRs no longer open", () => {
    // Arrange
    let callCount = 0
    const pr = makePR({ number: 1 })
    const getCIStatusMock = vi.fn<GitHubClientService["getCIStatus"]>()
      .mockReturnValueOnce(Effect.succeed({ state: "pending", checkRuns: [] }))
      .mockReturnValueOnce(Effect.succeed({
        state: "success",
        checkRuns: [{
          id: 1,
          name: "build",
          status: "completed",
          conclusion: "success",
          html_url: "",
          output: null,
          annotationMessages: []
        }]
      }))
    const githubMock = makeGitHubClientMock({
      listOpenPRs: vi.fn(() => {
        callCount++
        // Cycle 1: PR present (CI pending)
        if (callCount === 1) return Effect.succeed([pr])
        // Cycle 2: PR gone (state cleaned up)
        if (callCount === 2) return Effect.succeed([])
        // Cycle 3+: PR returns (should be treated as new, CI success)
        return Effect.succeed([pr])
      }),
      getCIStatus: getCIStatusMock,
      mergePR: vi.fn(() => Effect.succeed(undefined))
    })
    const config = makeRuntimeConfig({ autoMergeEnabled: true, autoMergeWaitMinutes: 0 })

    // Act — PR disappears and reappears; state should be cleaned up
    return takeEvents(1).pipe(
      Effect.provide(makeTestLayer(githubMock, config)),
      Effect.map((events) => {
        // Assert — PR should be treated as new (no stale state)
        expect(events).toHaveLength(1)
        expect(events[0]).toBeInstanceOf(PRAutoMerged)
      })
    )
  })
})
