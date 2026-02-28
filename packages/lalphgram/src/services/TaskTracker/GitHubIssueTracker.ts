/**
 * GitHub Issues implementation of TaskTracker
 * @since 1.0.0
 */
import { Array, DateTime, Duration, Effect, HashMap, Layer, Option, Ref, Schedule, Stream } from "effect"
import { TaskCreated, TaskUpdated } from "../../Events.js"
import type { TaskTrackerEvent } from "../../Events.js"
import { TrackerIssue, TrackerIssueEvent } from "../../schemas/TrackerSchemas.js"
import { AppRuntimeConfig } from "../AppRuntimeConfig.js"
import { LalphConfig } from "../LalphConfig.js"
import { OctokitClient } from "../OctokitClient.js"
import { TaskTracker, TaskTrackerError } from "./TaskTracker.js"

const extractRepoFullName = (repositoryUrl: string): string => {
  const parts = repositoryUrl.split("/repos/")
  return parts[1] ?? repositoryUrl
}

const deriveState = (githubState: string, labels: ReadonlyArray<string>): string => {
  if (githubState === "closed") return "Done"
  if (labels.includes("in-review")) return "In-review"
  if (labels.includes("in-progress")) return "In Progress"
  return "Todo"
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
    const config = yield* AppRuntimeConfig
    const lalphConfig = yield* LalphConfig
    const interval = Duration.seconds(config.pollIntervalSeconds)
    const repoFullName = lalphConfig.repoFullName

    const fetchRecentEvents = (since: string) =>
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
        const filteredIssues = Array.filter(
          issues,
          (issue) => extractRepoFullName(issue.repositoryUrl) === repoFullName
        )
        return Array.map(filteredIssues, (issue) => {
          const issueRepoFullName = extractRepoFullName(issue.repositoryUrl)
          const trackerIssue = new TrackerIssue({
            id: `${issueRepoFullName}#${issue.number}`,
            title: issue.title,
            state: deriveState(issue.state, issue.labels),
            url: issue.htmlUrl,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt
          })
          const action = issue.createdAt === issue.updatedAt ? "created" : "updated"
          return new TrackerIssueEvent({ action, issue: trackerIssue })
        })
      })

    const lastPollRef = yield* Ref.make(DateTime.unsafeNow())
    const knownStatesRef = yield* Ref.make(HashMap.empty<string, string>())

    const pollCycle = Effect.gen(function*() {
      const lastPoll = yield* Ref.get(lastPollRef)
      const since = DateTime.formatIso(lastPoll)
      const knownStates = yield* Ref.get(knownStatesRef)
      yield* Ref.set(lastPollRef, DateTime.unsafeNow())

      const issueEvents = yield* fetchRecentEvents(since)

      const events: Array<TaskTrackerEvent> = []
      for (const issueEvent of issueEvents) {
        if (issueEvent.action === "created") {
          events.push(new TaskCreated({ issue: issueEvent.issue }))
          yield* Ref.update(knownStatesRef, HashMap.set(issueEvent.issue.id, issueEvent.issue.state))
        } else {
          const previousState = HashMap.get(knownStates, issueEvent.issue.id)
          const stateChanged = Option.isNone(previousState) || previousState.value !== issueEvent.issue.state
          if (stateChanged) {
            events.push(
              new TaskUpdated({
                issue: issueEvent.issue,
                previousState: Option.getOrElse(previousState, () => "Unknown")
              })
            )
          }
          yield* Ref.update(knownStatesRef, HashMap.set(issueEvent.issue.id, issueEvent.issue.state))
        }
      }
      return events
    })

    const emptyBatch: Array<TaskTrackerEvent> = []
    const safePollCycle = pollCycle.pipe(
      Effect.tapError((err) => Effect.logError(`GitHubIssueTracker poll cycle failed: ${err.message}`)),
      Effect.orElseSucceed(() => emptyBatch)
    )

    const eventStream: Stream.Stream<TaskTrackerEvent, TaskTrackerError> = Stream.repeatEffectWithSchedule(
      safePollCycle,
      Schedule.spaced(interval)
    ).pipe(
      Stream.flatMap((batch) => Stream.fromIterable(batch))
    )

    return TaskTracker.of({
      eventStream,

      moveToTodo: (issueId) =>
        Effect.gen(function*() {
          const { issueNumber, owner, repo } = parseIssueId(issueId)
          const num = Number(issueNumber)
          yield* octokit.removeIssueLabel({ owner, repo, issueNumber: num, name: "in-progress" }).pipe(
            Effect.mapError((err) =>
              new TaskTrackerError({ message: `GitHub API request failed: ${String(err)}`, cause: err })
            )
          )
          yield* octokit.removeIssueLabel({ owner, repo, issueNumber: num, name: "in-review" }).pipe(
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
            state: deriveState(issue.state, issue.labels),
            url: issue.htmlUrl,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt
          })
        })
    })
  })
)
