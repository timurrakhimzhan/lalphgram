/**
 * TaskTracker service interface for task tracking backends
 * @since 1.0.0
 */
import type { Effect, Stream } from "effect"
import { Context, Data } from "effect"
import type { TaskTrackerEvent } from "../../Events.js"
import type { TrackerIssue } from "../../schemas/TrackerSchemas.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class TaskTrackerError extends Data.TaggedError("TaskTrackerError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface TaskTrackerService {
  readonly events: Stream.Stream<TaskTrackerEvent, TaskTrackerError>
  readonly moveToTodo: (issueId: string) => Effect.Effect<void, TaskTrackerError>
  readonly setPriorityUrgent: (issueId: string) => Effect.Effect<void, TaskTrackerError>
  readonly getIssue: (issueId: string) => Effect.Effect<TrackerIssue, TaskTrackerError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class TaskTracker extends Context.Tag("TaskTracker")<TaskTracker, TaskTrackerService>() {}
