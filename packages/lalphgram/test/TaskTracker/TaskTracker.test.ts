import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { AppRuntimeConfig, RuntimeConfig } from "../../src/services/AppRuntimeConfig.js"
import { LalphConfig } from "../../src/services/LalphConfig.js"
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

const linearLalphConfigMock = LalphConfig.of({
  githubToken: Effect.succeed(""),
  linearToken: Effect.succeed(""),
  issueSource: "linear",
  specUploader: "telegraph",
  repoFullName: "owner/my-repo",
  linearProjectIds: ["proj-id-1"]
})

const makeLinearTrackerTestLayer = (mock: LinearSdkClientService) =>
  LinearTrackerLive.pipe(
    Layer.provide(Layer.succeed(LinearSdkClient, mock)),
    Layer.provide(runtimeConfigLayer),
    Layer.provide(Layer.succeed(LalphConfig, linearLalphConfigMock))
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

  it.effect("passes project IDs to listIssues", () => {
    // Arrange
    const now = "2024-01-01T00:00:00.000Z"
    const mock = makeLinearSdkMock({
      listIssues: vi.fn(() =>
        Effect.succeed([{
          id: "id-1",
          identifier: "RAK-1",
          title: "Test issue",
          url: "https://linear.app/RAK-1",
          createdAt: now,
          updatedAt: now,
          stateName: "Todo"
        }])
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      yield* tracker.eventStream.pipe(Stream.take(1), Stream.runCollect)

      // Assert
      expect(mock.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: ["proj-id-1"] })
      )
    }).pipe(Effect.provide(makeLinearTrackerTestLayer(mock)))
  })
})

const makeGitHubOctokitMock = (overrides: Partial<OctokitClientService> = {}): OctokitClientService =>
  OctokitClient.of({
    getRateLimit: vi.fn(() => Effect.succeed({ limit: 5000, remaining: 5000, reset: 0 })),
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
        updatedAt: "",
        labels: []
      })
    ),
    addIssueLabels: vi.fn(() => Effect.void),
    removeIssueLabel: vi.fn(() => Effect.void),
    listPullReviewComments: vi.fn(() => Effect.succeed([])),
    getCombinedStatusForRef: vi.fn(() => Effect.succeed({ state: "success", statuses: [] })),
    listCheckRunsForRef: vi.fn(() => Effect.succeed([])),
    listCheckRunAnnotations: vi.fn(() => Effect.succeed([])),
    mergePull: vi.fn(() =>
      Effect.succeed({ sha: "abc123", merged: true, message: "Pull Request successfully merged" })
    ),
    createGist: vi.fn(() => Effect.succeed({ id: "1", htmlUrl: "https://gist.github.com/1", files: {} })),
    ...overrides
  })

const githubLalphConfigMock = LalphConfig.of({
  githubToken: Effect.succeed(""),
  linearToken: Effect.succeed(""),
  issueSource: "github",
  specUploader: "telegraph",
  repoFullName: "owner/my-repo",
  linearProjectIds: []
})

const makeGitHubIssueTrackerTestLayer = (mock: OctokitClientService) =>
  GitHubIssueTrackerLive.pipe(
    Layer.provide(Layer.succeed(OctokitClient, mock)),
    Layer.provide(runtimeConfigLayer),
    Layer.provide(Layer.succeed(LalphConfig, githubLalphConfigMock))
  )

describe("GitHubIssueTracker", () => {
  it.effect("moveToTodo removes in-progress and in-review labels", () => {
    // Arrange
    const mock = makeGitHubOctokitMock()

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      yield* tracker.moveToTodo("owner/repo#42")

      // Assert
      expect(mock.removeIssueLabel).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issueNumber: 42,
        name: "in-progress"
      })
      expect(mock.removeIssueLabel).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issueNumber: 42,
        name: "in-review"
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
          updatedAt: "2024-01-02T00:00:00Z",
          labels: []
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
      expect(issue.state).toBe("Todo")
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

  it.effect("filters out issues from other repos", () => {
    // Arrange
    const now = "2024-01-01T00:00:00.000Z"
    const mock = makeGitHubOctokitMock({
      listUserIssues: vi.fn(() =>
        Effect.succeed([
          {
            number: 1,
            title: "My repo issue",
            state: "open",
            htmlUrl: "https://github.com/owner/my-repo/issues/1",
            createdAt: now,
            updatedAt: now,
            repositoryUrl: "https://api.github.com/repos/owner/my-repo",
            labels: []
          },
          {
            number: 2,
            title: "Other repo issue",
            state: "open",
            htmlUrl: "https://github.com/owner/other-repo/issues/2",
            createdAt: now,
            updatedAt: now,
            repositoryUrl: "https://api.github.com/repos/owner/other-repo",
            labels: []
          }
        ])
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      const chunk = yield* tracker.eventStream.pipe(Stream.take(1), Stream.runCollect)
      const events = Array.from(chunk)

      // Assert
      expect(events).toHaveLength(1)
      expect(events[0]!._tag).toBe("TaskCreated")
      expect(events[0]!.issue.id).toBe("owner/my-repo#1")
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })

  it.live("emits TaskUpdated when label changes derive a new state", () => {
    // Arrange
    const created = "2024-01-01T00:00:00.000Z"
    const updated = "2024-01-02T00:00:00.000Z"
    let callCount = 0
    const mock = makeGitHubOctokitMock({
      listUserIssues: vi.fn(() => {
        callCount++
        if (callCount === 1) {
          return Effect.succeed([{
            number: 10,
            title: "Label test issue",
            state: "open",
            htmlUrl: "https://github.com/owner/my-repo/issues/10",
            createdAt: created,
            updatedAt: created,
            repositoryUrl: "https://api.github.com/repos/owner/my-repo",
            labels: []
          }])
        }
        return Effect.succeed([{
          number: 10,
          title: "Label test issue",
          state: "open",
          htmlUrl: "https://github.com/owner/my-repo/issues/10",
          createdAt: created,
          updatedAt: updated,
          repositoryUrl: "https://api.github.com/repos/owner/my-repo",
          labels: ["in-progress"]
        }])
      })
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act — first poll creates (state "Todo"), second poll detects label-derived state change
      const chunk = yield* tracker.eventStream.pipe(Stream.take(2), Stream.runCollect)
      const events = Array.from(chunk)

      // Assert
      expect(events).toHaveLength(2)
      expect(events[0]!._tag).toBe("TaskCreated")
      expect(events[0]!.issue.state).toBe("Todo")
      expect(events[1]!._tag).toBe("TaskUpdated")
      if (events[1]!._tag === "TaskUpdated") {
        expect(events[1]!.previousState).toBe("Todo")
        expect(events[1]!.issue.state).toBe("In Progress")
      }
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })

  it.live("derives state from labels: closed → Done, in-review → In-review, default → Todo", () => {
    // Arrange
    const now = "2024-01-01T00:00:00.000Z"
    const mock = makeGitHubOctokitMock({
      listUserIssues: vi.fn(() =>
        Effect.succeed([
          {
            number: 1,
            title: "Closed issue",
            state: "closed",
            htmlUrl: "https://github.com/owner/my-repo/issues/1",
            createdAt: now,
            updatedAt: now,
            repositoryUrl: "https://api.github.com/repos/owner/my-repo",
            labels: ["in-progress"]
          },
          {
            number: 2,
            title: "In review issue",
            state: "open",
            htmlUrl: "https://github.com/owner/my-repo/issues/2",
            createdAt: now,
            updatedAt: now,
            repositoryUrl: "https://api.github.com/repos/owner/my-repo",
            labels: ["in-review"]
          },
          {
            number: 3,
            title: "Plain issue",
            state: "open",
            htmlUrl: "https://github.com/owner/my-repo/issues/3",
            createdAt: now,
            updatedAt: now,
            repositoryUrl: "https://api.github.com/repos/owner/my-repo",
            labels: []
          }
        ])
      )
    })

    return Effect.gen(function*() {
      const tracker = yield* TaskTracker

      // Act
      const chunk = yield* tracker.eventStream.pipe(Stream.take(3), Stream.runCollect)
      const events = Array.from(chunk)

      // Assert — closed wins over in-progress label
      expect(events[0]!.issue.state).toBe("Done")
      expect(events[1]!.issue.state).toBe("In-review")
      expect(events[2]!.issue.state).toBe("Todo")
    }).pipe(Effect.provide(makeGitHubIssueTrackerTestLayer(mock)))
  })
})
