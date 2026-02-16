import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LalphConfig } from "../src/services/LalphConfig.js"
import { OctokitClient } from "../src/services/OctokitClient.js"
import type { OctokitClientService } from "../src/services/OctokitClient.js"
import { TrackerResolver, TrackerResolverError, TrackerResolverLive } from "../src/services/TrackerResolver.js"

const makeOctokitMock = (): OctokitClientService =>
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
        head: { ref: "" },
        mergeable: null
      })
    ),
    createIssueComment: vi.fn(() => Effect.void),
    listIssueComments: vi.fn(() => Effect.succeed([])),
    listUserIssues: vi.fn(() => Effect.succeed([])),
    getIssue: vi.fn(() =>
      Effect.succeed({
        number: 1,
        title: "",
        state: "open",
        htmlUrl: "",
        createdAt: "",
        updatedAt: ""
      })
    ),
    addIssueLabels: vi.fn(() => Effect.void),
    listPullReviewComments: vi.fn(() => Effect.succeed([]))
  })

const makeTestLayer = (issueSource: "linear" | "github", repoFullName: string) => {
  const configMock = LalphConfig.of({
    githubToken: Effect.succeed("test-token"),
    linearToken: Effect.succeed("test-linear-token"),
    issueSource,
    repoFullName
  })

  return TrackerResolverLive.pipe(
    Layer.provide(Layer.succeed(OctokitClient, makeOctokitMock())),
    Layer.provide(Layer.succeed(LalphConfig, configMock))
  )
}

describe("TrackerResolver", () => {
  it.effect("returns tracker for the configured repo", () =>
    Effect.gen(function*() {
      // Arrange
      const resolver = yield* TrackerResolver

      // Act
      const tracker = yield* resolver.trackerForRepo("owner/repo")

      // Assert
      expect(tracker).toBeDefined()
      expect(tracker.getRecentEvents).toBeDefined()
      expect(tracker.moveToTodo).toBeDefined()
    }).pipe(Effect.provide(makeTestLayer("github", "owner/repo"))))

  it.effect("fails with TrackerResolverError for unknown repo", () =>
    Effect.gen(function*() {
      // Arrange
      const resolver = yield* TrackerResolver

      // Act
      const error = yield* resolver.trackerForRepo("owner/unknown-repo").pipe(Effect.flip)

      // Assert
      expect(error).toBeInstanceOf(TrackerResolverError)
      expect(error.message).toContain("No tracker configured for repo: owner/unknown-repo")
    }).pipe(Effect.provide(makeTestLayer("github", "owner/repo"))))

  it.effect("allTrackers returns one tracker", () =>
    Effect.gen(function*() {
      // Arrange
      const resolver = yield* TrackerResolver

      // Act & Assert
      expect(resolver.allTrackers).toHaveLength(1)
    }).pipe(Effect.provide(makeTestLayer("github", "owner/repo"))))

  it.effect("allWatchedRepos returns the configured repo", () =>
    Effect.gen(function*() {
      // Arrange
      const resolver = yield* TrackerResolver

      // Act & Assert
      expect(resolver.allWatchedRepos).toEqual(["owner/repo"])
    }).pipe(Effect.provide(makeTestLayer("github", "owner/repo"))))
})
