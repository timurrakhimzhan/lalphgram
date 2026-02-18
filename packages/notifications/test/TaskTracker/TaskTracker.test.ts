import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppRuntimeConfig, RuntimeConfig } from "../../src/services/AppRuntimeConfig.js"
import type { LinearSdkClientService } from "../../src/services/LinearSdkClient.js"
import { LinearSdkClient, LinearSdkClientError } from "../../src/services/LinearSdkClient.js"
import type { OctokitClientService } from "../../src/services/OctokitClient.js"
import { OctokitClient, OctokitClientError } from "../../src/services/OctokitClient.js"
import { GitHubIssueTrackerLive } from "../../src/services/TaskTracker/GitHubIssueTracker.js"
import { LinearTrackerLive } from "../../src/services/TaskTracker/LinearTracker.js"
import { TaskTracker, TaskTrackerError } from "../../src/services/TaskTracker/TaskTracker.js"

const runtimeConfig = new RuntimeConfig({
  pollIntervalSeconds: 1,
  triggerKeyword: "urgent",
  timerDelaySeconds: 300
})

const runtimeConfigLayer = Layer.succeed(AppRuntimeConfig, runtimeConfig)

const makeLinearSdkMock = (overrides: Partial<LinearSdkClientService> = {}): LinearSdkClientService =>
  LinearSdkClient.of({
    listIssues: vi.fn(() => Effect.succeed([])),
    getIssue: vi.fn(() =>
      Effect.succeed({
        id: "id-1",
        identifier: "RAK-1",
        title: "",
        url: "",
        createdAt: "",
        updatedAt: "",
        stateName: "Unknown"
      })
    ),
    listWorkflowStates: vi.fn(() => Effect.succeed([])),
    updateIssue: vi.fn(() => Effect.void),
    updateIssuePriority: vi.fn(() => Effect.void),
    ...overrides
  })

const makeLinearTrackerTestLayer = (mock: LinearSdkClientService) =>
  LinearTrackerLive.pipe(
    Layer.provide(Layer.succeed(LinearSdkClient, mock)),
    Layer.provide(runtimeConfigLayer)
  )

describe("LinearTracker", () => {
  it.effect("moveToTodo resolves Todo state ID and updates issue", () => {
    // Arrange
    const mock = makeLinearSdkMock({
      listWorkflowStates: vi.fn(() =>
        Effect.succeed([
          { id: "state-1", name: "Todo", type: "unstarted" },
          { id: "state-2", name: "In Progress", type: "started" }
        ])
      ),
      updateIssue: vi.fn(() => Effect.void)
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      yield* tracker.moveToTodo("issue-id-1")

      // Assert
      expect(mock.listWorkflowStates).toHaveBeenCalledTimes(1)
      expect(mock.updateIssue).toHaveBeenCalledWith({ id: "issue-id-1", stateId: "state-1" })
    }).pipe(Effect.provide(makeLinearTrackerTestLayer(mock)))
  })

  it.effect("setPriorityUrgent calls updateIssuePriority with priority 1", () => {
    // Arrange
    const mock = makeLinearSdkMock({
      updateIssuePriority: vi.fn(() => Effect.void)
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      yield* tracker.setPriorityUrgent("issue-id-1")

      // Assert
      expect(mock.updateIssuePriority).toHaveBeenCalledWith({ id: "issue-id-1", priority: 1 })
    }).pipe(Effect.provide(makeLinearTrackerTestLayer(mock)))
  })

  it.effect("getIssue returns a TrackerIssue", () => {
    // Arrange
    const mock = makeLinearSdkMock({
      getIssue: vi.fn(() =>
        Effect.succeed({
          id: "id-5",
          identifier: "RAK-5",
          title: "Fetched issue",
          url: "https://linear.app/RAK-5",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
          stateName: "In Progress"
        })
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      const issue = yield* tracker.getIssue("issue-id-1")

      // Assert
      expect(issue.id).toBe("RAK-5")
      expect(issue.title).toBe("Fetched issue")
      expect(issue.state).toBe("In Progress")
      expect(mock.getIssue).toHaveBeenCalledWith({ id: "issue-id-1" })
    }).pipe(Effect.provide(makeLinearTrackerTestLayer(mock)))
  })

  it.effect("wraps LinearSdkClient errors in TaskTrackerError", () => {
    // Arrange
    const mock = makeLinearSdkMock({
      getIssue: vi.fn(() =>
        Effect.fail(new LinearSdkClientError({ message: "API error", cause: new Error("API error") }))
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      const result = yield* tracker.getIssue("issue-id-1").pipe(Effect.flip)

      // Assert
      expect(result).toBeInstanceOf(TaskTrackerError)
      expect(result.message).toContain("Failed to get issue")
    }).pipe(Effect.provide(makeLinearTrackerTestLayer(mock)))
  })
})

const makeGitHubOctokitMock = (overrides: Partial<OctokitClientService> = {}): OctokitClientService =>
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
        head: { ref: "", sha: "abc123" },
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
    listPullReviewComments: vi.fn(() => Effect.succeed([])),
    getCombinedStatusForRef: vi.fn(() => Effect.succeed({ state: "success", statuses: [] })),
    listCheckRunsForRef: vi.fn(() => Effect.succeed([])),
    mergePull: vi.fn(() =>
      Effect.succeed({ sha: "abc123", merged: true, message: "Pull Request successfully merged" })
    ),
    ...overrides
  })

const makeGitHubIssueTrackerTestLayer = (mock: OctokitClientService) =>
  GitHubIssueTrackerLive.pipe(
    Layer.provide(Layer.succeed(OctokitClient, mock)),
    Layer.provide(runtimeConfigLayer)
  )

describe("GitHubIssueTracker", () => {
  it.effect("moveToTodo adds a todo label to the issue", () => {
    // Arrange
    const mock = makeGitHubOctokitMock()

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      yield* tracker.moveToTodo("owner/repo#42")

      // Assert
      expect(mock.addIssueLabels).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issueNumber: 42,
        labels: ["todo"]
      })
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })

  it.effect("setPriorityUrgent adds urgent label to the issue", () => {
    // Arrange
    const mock = makeGitHubOctokitMock()

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      yield* tracker.setPriorityUrgent("owner/repo#42")

      // Assert
      expect(mock.addIssueLabels).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issueNumber: 42,
        labels: ["urgent"]
      })
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })

  it.effect("getIssue returns a TrackerIssue", () => {
    // Arrange
    const mock = makeGitHubOctokitMock({
      getIssue: vi.fn(() =>
        Effect.succeed({
          number: 42,
          title: "Fetched issue",
          state: "open",
          htmlUrl: "https://github.com/owner/repo/issues/42",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-02T00:00:00Z"
        })
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      const issue = yield* tracker.getIssue("owner/repo#42")

      // Assert
      expect(issue.id).toBe("owner/repo#42")
      expect(issue.title).toBe("Fetched issue")
      expect(issue.state).toBe("open")
      expect(issue.url).toBe("https://github.com/owner/repo/issues/42")
      expect(mock.getIssue).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issueNumber: 42
      })
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })

  it.effect("wraps OctokitClient errors in TaskTrackerError", () => {
    // Arrange
    const mock = makeGitHubOctokitMock({
      getIssue: vi.fn(() =>
        Effect.fail(new OctokitClientError({ message: "Unauthorized", cause: new Error("Unauthorized") }))
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      const result = yield* tracker.getIssue("owner/repo#42").pipe(Effect.flip)

      // Assert
      expect(result).toBeInstanceOf(TaskTrackerError)
      expect(result.message).toContain("GitHub API request failed")
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })
})
