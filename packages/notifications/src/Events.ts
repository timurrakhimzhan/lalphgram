/**
 * Event types for the notification system
 * @since 1.0.0
 */
import { Data } from "effect"
import type { GitHubComment, GitHubPullRequest } from "./schemas/GitHubSchemas.js"
import type { TrackerIssue } from "./schemas/TrackerSchemas.js"

/**
 * @since 1.0.0
 * @category events
 */
export class TaskCreated extends Data.TaggedClass("TaskCreated")<{
  readonly issue: TrackerIssue
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class TaskUpdated extends Data.TaggedClass("TaskUpdated")<{
  readonly issue: TrackerIssue
  readonly previousState: string
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PROpened extends Data.TaggedClass("PROpened")<{
  readonly pr: GitHubPullRequest
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PRConflictDetected extends Data.TaggedClass("PRConflictDetected")<{
  readonly pr: GitHubPullRequest
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PRCommentAdded extends Data.TaggedClass("PRCommentAdded")<{
  readonly pr: GitHubPullRequest
  readonly comment: GitHubComment
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export type AppEvent = TaskCreated | TaskUpdated | PROpened | PRConflictDetected | PRCommentAdded
