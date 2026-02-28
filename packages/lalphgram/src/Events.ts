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
export class PRAutoMerged extends Data.TaggedClass("PRAutoMerged")<{
  readonly pr: GitHubPullRequest
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PRCIFailed extends Data.TaggedClass("PRCIFailed")<{
  readonly pr: GitHubPullRequest
  readonly failedChecks: ReadonlyArray<{
    readonly name: string
    readonly html_url: string
    readonly conclusion: string
  }>
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export type AutoMergeEvent = PRAutoMerged

/**
 * @since 1.0.0
 * @category events
 */
export type PullRequestEvent =
  | PROpened
  | PRConflictDetected
  | PRCommentAdded
  | PRCIFailed

/**
 * @since 1.0.0
 * @category events
 */
export type TaskTrackerEvent = TaskCreated | TaskUpdated

/**
 * @since 1.0.0
 * @category events
 */
export type AppEvent = PullRequestEvent | AutoMergeEvent | TaskTrackerEvent
