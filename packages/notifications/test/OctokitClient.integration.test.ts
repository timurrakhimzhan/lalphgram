import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LalphConfig } from "../src/services/LalphConfig.js"
import { etagCache, OctokitClient, OctokitClientLive } from "../src/services/OctokitClient.js"

const token = process.env.GITHUB_TOKEN ?? ""

const TestLayer = OctokitClientLive.pipe(
  Layer.provide(
    Layer.succeed(
      LalphConfig,
      LalphConfig.of({
        githubToken: Effect.succeed(token),
        linearToken: Effect.succeed(""),
        issueSource: "github",
        specUploader: "gist",
        repoFullName: "owner/repo"
      })
    )
  )
)

describe.skipIf(!token)("ETag caching (integration)", () => {
  it.effect("304 response does not consume rate limit", () =>
    Effect.gen(function*() {
      // Arrange
      const client = yield* OctokitClient
      etagCache.clear()

      // Act — first call fetches fresh data and caches ETag
      yield* client.getAuthenticatedUser()
      const rateBefore = yield* client.getRateLimit()

      // second call should send If-None-Match, get 304, return cached
      const secondResult = yield* client.getAuthenticatedUser()
      const rateAfter = yield* client.getRateLimit()

      // Assert — second call didn't consume rate limit
      expect(secondResult.login).toBeTruthy()
      expect(rateAfter.remaining).toBe(rateBefore.remaining)
    }).pipe(Effect.provide(TestLayer)), { timeout: 10_000 })
})
