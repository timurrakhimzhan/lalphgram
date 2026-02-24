import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { LalphConfig, LalphConfigError } from "../src/services/LalphConfig.js"
import { OctokitClient } from "../src/services/OctokitClient.js"
import {
  CloudflareSpecUploaderLive,
  GistSpecUploaderLive,
  SpecUploader,
  SpecUploaderError,
  TelegraphSpecUploaderLive
} from "../src/services/SpecUploader.js"

const testHtml = "<!DOCTYPE html><html><body>test</body></html>"
const testDescription = "Spec: Feature"

describe("CloudflareSpecUploaderLive", () => {
  it.effect("uploads HTML and returns URL from worker response", () => {
    // Arrange
    const mockResponse = { url: "https://spec-worker.example.com/abc-123" }
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 })))
    vi.stubGlobal("fetch", fetchSpy)

    const configMock = LalphConfig.of({
      githubToken: Effect.fail(new LalphConfigError({ message: "not needed", cause: null })),
      linearToken: Effect.fail(new LalphConfigError({ message: "not needed", cause: null })),
      issueSource: "github",
      specUploader: "cloudflare",
      specUploaderUrl: Effect.succeed("https://spec-worker.example.com"),
      repoFullName: "test/test"
    })

    const testLayer = CloudflareSpecUploaderLive.pipe(
      Layer.provide(Layer.succeed(LalphConfig, configMock))
    )

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription)

      expect(result.url).toBe("https://spec-worker.example.com/abc-123")
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://spec-worker.example.com",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "text/html" },
          body: testHtml
        })
      )
    }).pipe(
      Effect.provide(testLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))
    )
  })

  it.effect("fails with SpecUploaderError on non-OK response", () => {
    // Arrange
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }))
      )
    )

    const configMock = LalphConfig.of({
      githubToken: Effect.fail(new LalphConfigError({ message: "not needed", cause: null })),
      linearToken: Effect.fail(new LalphConfigError({ message: "not needed", cause: null })),
      issueSource: "github",
      specUploader: "cloudflare",
      specUploaderUrl: Effect.succeed("https://spec-worker.example.com"),
      repoFullName: "test/test"
    })

    const testLayer = CloudflareSpecUploaderLive.pipe(
      Layer.provide(Layer.succeed(LalphConfig, configMock))
    )

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription).pipe(Effect.flip)

      expect(result).toBeInstanceOf(SpecUploaderError)
      expect(result.message).toContain("500")
    }).pipe(
      Effect.provide(testLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))
    )
  })

  it.effect("fails with SpecUploaderError on network error", () => {
    // Arrange
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Network failure"))))

    const configMock = LalphConfig.of({
      githubToken: Effect.fail(new LalphConfigError({ message: "not needed", cause: null })),
      linearToken: Effect.fail(new LalphConfigError({ message: "not needed", cause: null })),
      issueSource: "github",
      specUploader: "cloudflare",
      specUploaderUrl: Effect.succeed("https://spec-worker.example.com"),
      repoFullName: "test/test"
    })

    const testLayer = CloudflareSpecUploaderLive.pipe(
      Layer.provide(Layer.succeed(LalphConfig, configMock))
    )

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription).pipe(Effect.flip)

      expect(result).toBeInstanceOf(SpecUploaderError)
      expect(result.message).toContain("Failed to upload spec to Cloudflare Worker")
    }).pipe(
      Effect.provide(testLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals()))
    )
  })
})

describe("GistSpecUploaderLive", () => {
  it.effect("uploads HTML via createGist and returns htmlpreview URL", () => {
    // Arrange
    const octokitMock = OctokitClient.of({
      getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "test" })),
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
      )
    })

    const testLayer = GistSpecUploaderLive.pipe(
      Layer.provide(Layer.succeed(OctokitClient, octokitMock))
    )

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription)

      expect(result.url).toBe(
        "https://htmlpreview.github.io/?https://gist.githubusercontent.com/raw/spec.html"
      )
      expect(octokitMock.createGist).toHaveBeenCalledWith({
        description: testDescription,
        files: { "spec.html": { content: testHtml } },
        isPublic: false
      })
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("falls back to htmlUrl when spec.html rawUrl is missing", () => {
    // Arrange
    const octokitMock = OctokitClient.of({
      getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "test" })),
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
          id: "gist-456",
          htmlUrl: "https://gist.github.com/gist-456",
          files: {}
        })
      )
    })

    const testLayer = GistSpecUploaderLive.pipe(
      Layer.provide(Layer.succeed(OctokitClient, octokitMock))
    )

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription)

      expect(result.url).toBe("https://htmlpreview.github.io/?https://gist.github.com/gist-456")
    }).pipe(Effect.provide(testLayer))
  })
})

const makeJsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  )

const makeTelegraphHttpClient = (
  responses: Record<string, unknown>
) => {
  const executeSpy = vi.fn((request: HttpClientRequest.HttpClientRequest) => {
    for (const [urlFragment, body] of Object.entries(responses)) {
      if (request.url.includes(urlFragment)) {
        return Effect.succeed(makeJsonResponse(request, body))
      }
    }
    return Effect.succeed(makeJsonResponse(request, { ok: false, error: "unexpected URL" }))
  })
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => executeSpy(request))
  )
  return { executeSpy, httpLayer }
}

describe("TelegraphSpecUploaderLive", () => {
  it.effect("creates account on construction and creates page on upload", () => {
    // Arrange
    const { executeSpy, httpLayer } = makeTelegraphHttpClient({
      createAccount: { ok: true, result: { access_token: "test-token-123" } },
      createPage: { ok: true, result: { url: "https://telegra.ph/Test-Page-01-01" } }
    })

    const testLayer = TelegraphSpecUploaderLive.pipe(Layer.provide(httpLayer))

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription)

      expect(result.url).toBe("https://telegra.ph/Test-Page-01-01")
      expect(executeSpy).toHaveBeenCalledTimes(2)
      expect(executeSpy.mock.calls[0]?.[0].url).toContain("createAccount")
      expect(executeSpy.mock.calls[1]?.[0].url).toContain("createPage")
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("fails with SpecUploaderError on Telegraph API error", () => {
    // Arrange
    const { httpLayer } = makeTelegraphHttpClient({
      createAccount: { ok: true, result: { access_token: "test-token-123" } },
      createPage: { ok: false, error: "CONTENT_TOO_BIG" }
    })

    const testLayer = TelegraphSpecUploaderLive.pipe(Layer.provide(httpLayer))

    // Act & Assert
    return Effect.gen(function*() {
      const uploader = yield* SpecUploader
      const result = yield* uploader.upload(testHtml, testDescription).pipe(Effect.flip)

      expect(result).toBeInstanceOf(SpecUploaderError)
      expect(result.message).toContain("CONTENT_TOO_BIG")
    }).pipe(Effect.provide(testLayer))
  })

  it.effect("fails with SpecUploaderError when createAccount fails", () => {
    // Arrange
    const { httpLayer } = makeTelegraphHttpClient({
      createAccount: { ok: false, error: "SHORT_NAME_REQUIRED" }
    })

    const testLayer = TelegraphSpecUploaderLive.pipe(Layer.provide(httpLayer))

    // Act & Assert
    return Effect.gen(function*() {
      const result = yield* Effect.provide(SpecUploader, testLayer).pipe(Effect.flip)

      expect(result).toBeInstanceOf(SpecUploaderError)
      expect(result.message).toContain("SHORT_NAME_REQUIRED")
    })
  })
})
