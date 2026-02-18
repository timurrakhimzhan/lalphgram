/**
 * Linear SDK implementation of TaskTracker
 * @since 1.0.0
 */
import { Effect, Layer, Ref } from "effect"
import { TrackerIssue, TrackerIssueEvent } from "../../schemas/TrackerSchemas.js"
import { LinearSdkClient } from "../LinearSdkClient.js"
import { TaskTracker, TaskTrackerError } from "./TaskTracker.js"

export const LinearTrackerLive = Layer.effect(
  TaskTracker,
  Effect.gen(function*() {
    const linearClient = yield* LinearSdkClient
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

    return TaskTracker.of({
      getRecentEvents: (since) =>
        linearClient.listIssues({ since }).pipe(
          Effect.map((issues) =>
            issues.map((node): TrackerIssueEvent => {
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
        ),

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
