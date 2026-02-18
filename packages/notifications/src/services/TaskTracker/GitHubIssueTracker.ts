/**
 * GitHub Issues implementation of TaskTracker
 * @since 1.0.0
 */
import { Array, Effect, Layer } from "effect"
import { TrackerIssue, TrackerIssueEvent } from "../../schemas/TrackerSchemas.js"
import { OctokitClient } from "../OctokitClient.js"
import { TaskTracker, TaskTrackerError } from "./TaskTracker.js"

const extractRepoFullName = (repositoryUrl: string): string => {
  const parts = repositoryUrl.split("/repos/")
  return parts[1] ?? repositoryUrl
}

const parseIssueId = (issueId: string) => {
  const slashIdx = issueId.indexOf("/")
  const hashIdx = issueId.indexOf("#")
  const owner = issueId.substring(0, slashIdx)
  const repo = issueId.substring(slashIdx + 1, hashIdx)
  const issueNumber = issueId.substring(hashIdx + 1)
  return { owner, repo, issueNumber }
}

export const GitHubIssueTrackerLive = Layer.effect(
  TaskTracker,
  Effect.gen(function*() {
    const octokit = yield* OctokitClient

    return TaskTracker.of({
      getRecentEvents: (since) =>
        Effect.gen(function*() {
          const issues = yield* octokit.listUserIssues({
            state: "all",
            sort: "updated",
            since
          }).pipe(
            Effect.mapError((err) =>
              new TaskTrackerError({ message: `GitHub API request failed: ${String(err)}`, cause: err })
            )
          )
          return Array.map(issues, (issue): TrackerIssueEvent => {
            const repoFullName = extractRepoFullName(issue.repositoryUrl)
            const trackerIssue = new TrackerIssue({
              id: `${repoFullName}#${issue.number}`,
              title: issue.title,
              state: issue.state,
              url: issue.htmlUrl,
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt
            })
            const action = issue.createdAt === issue.updatedAt ? "created" : "updated"
            return new TrackerIssueEvent({ action, issue: trackerIssue })
          })
        }),

      moveToTodo: (issueId) =>
        Effect.gen(function*() {
          const { issueNumber, owner, repo } = parseIssueId(issueId)
          yield* octokit.addIssueLabels({
            owner,
            repo,
            issueNumber: Number(issueNumber),
            labels: ["todo"]
          }).pipe(
            Effect.mapError((err) =>
              new TaskTrackerError({ message: `GitHub API request failed: ${String(err)}`, cause: err })
            )
          )
        }),

      setPriorityUrgent: (issueId) =>
        Effect.gen(function*() {
          const { issueNumber, owner, repo } = parseIssueId(issueId)
          yield* octokit.addIssueLabels({
            owner,
            repo,
            issueNumber: Number(issueNumber),
            labels: ["urgent"]
          }).pipe(
            Effect.mapError((err) =>
              new TaskTrackerError({ message: `GitHub API request failed: ${String(err)}`, cause: err })
            )
          )
        }),

      getIssue: (issueId) =>
        Effect.gen(function*() {
          const { issueNumber, owner, repo } = parseIssueId(issueId)
          const issue = yield* octokit.getIssue({
            owner,
            repo,
            issueNumber: Number(issueNumber)
          }).pipe(
            Effect.mapError((err) =>
              new TaskTrackerError({ message: `GitHub API request failed: ${String(err)}`, cause: err })
            )
          )
          return new TrackerIssue({
            id: `${owner}/${repo}#${issue.number}`,
            title: issue.title,
            state: issue.state,
            url: issue.htmlUrl,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt
          })
        })
    })
  })
)
