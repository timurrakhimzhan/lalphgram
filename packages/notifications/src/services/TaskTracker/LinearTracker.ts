/**
 * Linear SDK implementation of TaskTracker
 * @since 1.0.0
 */
import { DateTime, Duration, Effect, HashMap, Layer, Option, Ref, Schedule, Stream } from "effect"
import { TaskCreated, TaskUpdated } from "../../Events.js"
import type { AppEvent } from "../../Events.js"
import { TrackerIssue, TrackerIssueEvent } from "../../schemas/TrackerSchemas.js"
import { AppRuntimeConfig } from "../AppRuntimeConfig.js"
import { LinearSdkClient } from "../LinearSdkClient.js"
import { TaskTracker, TaskTrackerError } from "./TaskTracker.js"

export const LinearTrackerLive = Layer.effect(
  TaskTracker,
  Effect.gen(function*() {
    const linearClient = yield* LinearSdkClient
    const config = yield* AppRuntimeConfig
    const interval = Duration.seconds(config.pollIntervalSeconds)
    const todoStateIdRef = yield* Ref.make<string | null>(null)

    const resolveTodoStateId = Effect.gen(function*() {
      const cached = yield* Ref.get(todoStateIdRef)
      if (cached !== null) return cached

      const states = yield* linearClient.listWorkflowStates().pipe(
        Effect.mapError((err) =>
          new TaskTrackerError({ message: `Failed to fetch workflow states: ${err.message}`, cause: err })
        )
      )
      const todoState = states.find((s) => s.name === "Todo")
      if (!todoState) {
        return yield* new TaskTrackerError({ message: "No 'Todo' workflow state found", cause: null })
      }
      yield* Ref.set(todoStateIdRef, todoState.id)
      return todoState.id
    })

    const fetchRecentEvents = (since: string) =>
      linearClient.listIssues({ since }).pipe(
        Effect.map((issues) =>
          issues.map((node) => {
            const issue = new TrackerIssue({
              id: node.identifier,
              title: node.title,
              state: node.stateName,
              url: node.url,
              createdAt: node.createdAt,
              updatedAt: node.updatedAt
            })
            const action = node.createdAt === node.updatedAt ? "created" : "updated"
            return new TrackerIssueEvent({ action, issue })
          })
        ),
        Effect.mapError((err) =>
          new TaskTrackerError({ message: `Failed to get recent events: ${err.message}`, cause: err })
        )
      )

    const lastPollRef = yield* Ref.make(DateTime.unsafeNow())
    const knownStatesRef = yield* Ref.make(HashMap.empty<string, string>())

    const pollCycle = Effect.gen(function*() {
      const lastPoll = yield* Ref.get(lastPollRef)
      const since = DateTime.formatIso(lastPoll)
      const knownStates = yield* Ref.get(knownStatesRef)
      yield* Ref.set(lastPollRef, DateTime.unsafeNow())

      const issueEvents = yield* fetchRecentEvents(since)

      const events: Array<AppEvent> = []
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

    const emptyBatch: Array<AppEvent> = []
    const safePollCycle = pollCycle.pipe(
      Effect.tapError((err) => Effect.logError(`LinearTracker poll cycle failed: ${err.message}`)),
      Effect.orElseSucceed(() => emptyBatch)
    )

    const eventStream: Stream.Stream<AppEvent, TaskTrackerError> = Stream.repeatEffectWithSchedule(
      safePollCycle,
      Schedule.spaced(interval)
    ).pipe(
      Stream.flatMap((batch) => Stream.fromIterable(batch))
    )

    return TaskTracker.of({
      events: eventStream,

      moveToTodo: (issueId) =>
        Effect.gen(function*() {
          const stateId = yield* resolveTodoStateId
          yield* linearClient.updateIssue({ id: issueId, stateId }).pipe(
            Effect.mapError((err) =>
              new TaskTrackerError({ message: `Failed to update issue state: ${err.message}`, cause: err })
            )
          )
        }),

      setPriorityUrgent: (issueId) =>
        linearClient.updateIssuePriority({ id: issueId, priority: 1 }).pipe(
          Effect.mapError((err) =>
            new TaskTrackerError({ message: `Failed to set priority urgent: ${err.message}`, cause: err })
          )
        ),

      getIssue: (issueId) =>
        linearClient.getIssue({ id: issueId }).pipe(
          Effect.map((node) =>
            new TrackerIssue({
              id: node.identifier,
              title: node.title,
              state: node.stateName,
              url: node.url,
              createdAt: node.createdAt,
              updatedAt: node.updatedAt
            })
          ),
          Effect.mapError((err) => new TaskTrackerError({ message: `Failed to get issue: ${err.message}`, cause: err }))
        )
    })
  })
)
