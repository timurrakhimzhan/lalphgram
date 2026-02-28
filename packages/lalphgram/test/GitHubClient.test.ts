import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { GitHubRepo } from "../src/schemas/GitHubSchemas.js"
import { GitHubClient, GitHubClientError, GitHubClientLive, isBillingFailure } from "../src/services/GitHubClient.js"
import type { OctokitClientService } from "../src/services/OctokitClient.js"
import { OctokitClient, OctokitClientError } from "../src/services/OctokitClient.js"

const testRepo = new GitHubRepo({
  id: 1,
  name: "my-repo",
  full_name: "owner/my-repo",
  owner: { login: "owner" },
  html_url: "https://github.com/owner/my-repo"
})

const makeOctokitMock = (): OctokitClientService => ({
  getRateLimit: vi.fn(() => Effect.succeed({ limit: 5000, remaining: 5000, reset: 0 })),
  getAuthenticatedUser: vi.fn(() => Effect.succeed({ login: "test-user" })),
  listUserRepos: vi.fn(() =>
    Effect.succeed([{
      id: 1,
      name: "my-repo",
      fullName: "owner/my-repo",
      owner: { login: "owner" },
      htmlUrl: "https://github.com/owner/my-repo"
    }])
  ),
  listPulls: vi.fn(() =>
    Effect.succeed([{
      id: 100,
      number: 42,
      title: "Add feature",
      state: "open",
      htmlUrl: "https://github.com/owner/my-repo/pull/42",
      head: { ref: "feature/add-thing", sha: "abc123" }
    }])
  ),
  getPull: vi.fn(() =>
    Effect.succeed({
      id: 100,
      number: 42,
      title: "Some PR",
      state: "open",
      htmlUrl: "https://github.com/owner/my-repo/pull/42",
      head: { ref: "feature/branch", sha: "abc123" },
      mergeable: null
    })
  ),
  createIssueComment: vi.fn(() => Effect.void),
  listIssueComments: vi.fn(() =>
    Effect.succeed([{
      id: 200,
      body: "Nice work!",
      user: { login: "reviewer" },
      createdAt: "2024-01-15T10:00:00Z",
      htmlUrl: "https://github.com/owner/my-repo/pull/42#issuecomment-200"
    }])
  ),
  listUserIssues: vi.fn(() => Effect.succeed([])),
  getIssue: vi.fn(() =>
    Effect.succeed({
      number: 1,
      title: "",
      state: "open",
      htmlUrl: "",
      createdAt: "",
      updatedAt: "",
      labels: []
    })
  ),
  addIssueLabels: vi.fn(() => Effect.void),
  removeIssueLabel: vi.fn(() => Effect.void),
  listPullReviewComments: vi.fn(() =>
    Effect.succeed([{
      id: 300,
      body: "Review comment",
      user: { login: "reviewer" },
      createdAt: "2024-01-15T11:00:00Z",
      htmlUrl: "https://github.com/owner/my-repo/pull/42#discussion_r300"
    }])
  ),
  getCombinedStatusForRef: vi.fn(() => Effect.succeed({ state: "success", statuses: [] })),
  listCheckRunsForRef: vi.fn(() => Effect.succeed([])),
  listCheckRunAnnotations: vi.fn(() => Effect.succeed([])),
  mergePull: vi.fn(() => Effect.succeed({ sha: "abc123", merged: true, message: "Pull Request successfully merged" })),
  createGist: vi.fn(() => Effect.succeed({ id: "1", htmlUrl: "https://gist.github.com/1", files: {} }))
})

const makeTestLayer = (mock: OctokitClientService) =>
  GitHubClientLive.pipe(
    Layer.provide(Layer.succeed(OctokitClient, mock))
  )

describe("GitHubClient", () => {
  it.effect("getAuthenticatedUser returns the login", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const user = yield* client.getAuthenticatedUser()

      // Assert
      expect(user.login).toBe("test-user")
      expect(mock.getAuthenticatedUser).toHaveBeenCalled()
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("listUserRepos returns decoded repos", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const repos = yield* client.listUserRepos()

      // Assert
      expect(repos).toHaveLength(1)
      expect(repos[0]?.full_name).toBe("owner/my-repo")
      expect(repos[0]?.owner.login).toBe("owner")
      expect(mock.listUserRepos).toHaveBeenCalledWith({ perPage: 100, type: "owner" })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("listOpenPRs returns decoded pull requests with repo field", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const prs = yield* client.listOpenPRs(testRepo)

      // Assert
      expect(prs).toHaveLength(1)
      expect(prs[0]?.number).toBe(42)
      expect(prs[0]?.title).toBe("Add feature")
      expect(prs[0]?.headRef).toBe("feature/add-thing")
      expect(prs[0]?.hasConflicts).toBe(false)
      expect(prs[0]?.repo).toBe("owner/my-repo")
      expect(mock.listPulls).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        state: "open",
        perPage: 100
      })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("getPR handles mergeable: null as hasConflicts: false", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const pr = yield* client.getPR(testRepo, 42)

      // Assert
      expect(pr.number).toBe(42)
      expect(pr.hasConflicts).toBe(false)
      expect(pr.repo).toBe("owner/my-repo")
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("getPR detects conflicts when mergeable is false", () => {
    // Arrange
    const mock: OctokitClientService = {
      ...makeOctokitMock(),
      getPull: vi.fn(() =>
        Effect.succeed({
          id: 101,
          number: 43,
          title: "Conflicted PR",
          state: "open",
          htmlUrl: "https://github.com/owner/my-repo/pull/43",
          head: { ref: "feature/conflicted", sha: "def456" },
          mergeable: false
        })
      )
    }

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const pr = yield* client.getPR(testRepo, 43)

      // Assert
      expect(pr.number).toBe(43)
      expect(pr.hasConflicts).toBe(true)
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("postComment sends a comment with correct parameters", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      yield* client.postComment(testRepo, 42, "LGTM!")

      // Assert
      expect(mock.createIssueComment).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        issueNumber: 42,
        body: "LGTM!"
      })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("listComments returns comments with injected repo field", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const comments = yield* client.listComments(testRepo, 42)

      // Assert
      expect(comments).toHaveLength(1)
      expect(comments[0]?.body).toBe("Nice work!")
      expect(comments[0]?.user.login).toBe("reviewer")
      expect(comments[0]?.repo).toBe("owner/my-repo")
      expect(mock.listIssueComments).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        issueNumber: 42,
        perPage: 100
      })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("listReviewComments returns review comments with injected repo field", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const comments = yield* client.listReviewComments(testRepo, 42)

      // Assert
      expect(comments).toHaveLength(1)
      expect(comments[0]?.body).toBe("Review comment")
      expect(comments[0]?.user.login).toBe("reviewer")
      expect(comments[0]?.repo).toBe("owner/my-repo")
      expect(mock.listPullReviewComments).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        pullNumber: 42,
        perPage: 100
      })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("getCIStatus combines status and check runs", () => {
    // Arrange
    const mock: OctokitClientService = {
      ...makeOctokitMock(),
      getCombinedStatusForRef: vi.fn(() =>
        Effect.succeed({
          state: "success",
          statuses: [{ state: "success", context: "ci/build" }]
        })
      ),
      listCheckRunsForRef: vi.fn(() =>
        Effect.succeed([{
          id: 1,
          name: "test-suite",
          status: "completed",
          conclusion: "success",
          htmlUrl: "https://github.com/owner/my-repo/runs/1",
          output: null
        }])
      )
    }

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const ciStatus = yield* client.getCIStatus(testRepo, "abc123")

      // Assert
      expect(ciStatus.state).toBe("success")
      expect(ciStatus.checkRuns).toHaveLength(1)
      expect(ciStatus.checkRuns[0]?.name).toBe("test-suite")
      expect(ciStatus.checkRuns[0]?.status).toBe("completed")
      expect(ciStatus.checkRuns[0]?.conclusion).toBe("success")
      expect(ciStatus.checkRuns[0]?.html_url).toBe("https://github.com/owner/my-repo/runs/1")
      expect(ciStatus.checkRuns[0]?.annotationMessages).toEqual([])
      expect(mock.getCombinedStatusForRef).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        ref: "abc123"
      })
      expect(mock.listCheckRunsForRef).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        ref: "abc123"
      })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("getCIStatus wraps errors in GitHubClientError", () => {
    // Arrange
    const mock: OctokitClientService = {
      ...makeOctokitMock(),
      getCombinedStatusForRef: vi.fn(() => Effect.fail(new OctokitClientError({ message: "Not found", cause: null })))
    }

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const result = yield* client.getCIStatus(testRepo, "abc123").pipe(Effect.flip)

      // Assert
      expect(result).toBeInstanceOf(GitHubClientError)
      expect(result.message).toContain("Failed to get CI status")
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("mergePR calls octokit mergePull with correct parameters", () => {
    // Arrange
    const mock = makeOctokitMock()

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      yield* client.mergePR(testRepo, 42)

      // Assert
      expect(mock.mergePull).toHaveBeenCalledWith({
        owner: "owner",
        repo: "my-repo",
        pullNumber: 42
      })
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("mergePR wraps errors in GitHubClientError", () => {
    // Arrange
    const mock: OctokitClientService = {
      ...makeOctokitMock(),
      mergePull: vi.fn(() => Effect.fail(new OctokitClientError({ message: "Merge conflict", cause: null })))
    }

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const result = yield* client.mergePR(testRepo, 42).pipe(Effect.flip)

      // Assert
      expect(result).toBeInstanceOf(GitHubClientError)
      expect(result.message).toContain("Failed to merge PR")
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })

  it.effect("wraps OctokitClient errors in GitHubClientError", () => {
    // Arrange
    const mock: OctokitClientService = {
      ...makeOctokitMock(),
      getAuthenticatedUser: vi.fn(() =>
        Effect.fail(new OctokitClientError({ message: "Unauthorized", cause: new Error("Unauthorized") }))
      )
    }

    return Effect.gen(function*() {
      const client = yield* GitHubClient

      // Act
      const result = yield* client.getAuthenticatedUser().pipe(Effect.flip)

      // Assert
      expect(result).toBeInstanceOf(GitHubClientError)
      expect(result.message).toContain("Failed to get authenticated user")
    }).pipe(Effect.provide(makeTestLayer(mock)))
  })
})

describe("isBillingFailure", () => {
  it("returns false for non-failure conclusion", () => {
    // Arrange
    const checkRun = {
      conclusion: "success",
      output: { summary: "account payments have failed" },
      annotationMessages: []
    }

    // Act
    const result = isBillingFailure(checkRun)

    // Assert
    expect(result).toBe(false)
  })

  it("returns true when output.summary contains billing text", () => {
    // Arrange
    const checkRun = {
      conclusion: "failure",
      output: {
        summary:
          "The job was not started because recent account payments have failed or your spending limit needs to be increased."
      },
      annotationMessages: []
    }

    // Act
    const result = isBillingFailure(checkRun)

    // Assert
    expect(result).toBe(true)
  })

  it("returns true when annotationMessages contain billing text", () => {
    // Arrange
    const checkRun = {
      conclusion: "failure",
      output: null,
      annotationMessages: [
        "The job running on runner GitHub Actions has exceeded the spending limit of the account payments have failed."
      ]
    }

    // Act
    const result = isBillingFailure(checkRun)

    // Assert
    expect(result).toBe(true)
  })

  it("returns true when annotationMessages contain spending limit text", () => {
    // Arrange
    const checkRun = {
      conclusion: "failure",
      output: null,
      annotationMessages: ["Your spending limit has been reached."]
    }

    // Act
    const result = isBillingFailure(checkRun)

    // Assert
    expect(result).toBe(true)
  })

  it("returns false when failure has no billing text anywhere", () => {
    // Arrange
    const checkRun = {
      conclusion: "failure",
      output: { summary: "Build failed with 3 errors" },
      annotationMessages: ["Error: tests failed"]
    }

    // Act
    const result = isBillingFailure(checkRun)

    // Assert
    expect(result).toBe(false)
  })
})
