/**
 * TrackerResolver maps repos to tracker instances based on monitor configuration
 * @since 1.0.0
 */
import { Context, Data, Effect, Layer } from "effect"
import { GitHubIssueTrackerLive } from "./GitHubIssueTracker.js"
import { LalphConfig } from "./LalphConfig.js"
import { LinearSdkClientLive } from "./LinearSdkClient.js"
import { LinearTrackerLive } from "./LinearTracker.js"
import { OctokitClient } from "./OctokitClient.js"
import type { TaskTrackerService } from "./TaskTracker.js"
import { TaskTracker } from "./TaskTracker.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class TrackerResolverError extends Data.TaggedError("TrackerResolverError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface TrackerResolverService {
  readonly trackerForRepo: (repoFullName: string) => Effect.Effect<TaskTrackerService, TrackerResolverError>
  readonly allTrackers: ReadonlyArray<TaskTrackerService>
  readonly allWatchedRepos: ReadonlyArray<string>
}

/**
 * @since 1.0.0
 * @category context
 */
export class TrackerResolver extends Context.Tag("TrackerResolver")<
  TrackerResolver,
  TrackerResolverService
>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const TrackerResolverLive = Layer.effect(
  TrackerResolver,
  Effect.gen(function*() {
    const octokit = yield* OctokitClient
    const config = yield* LalphConfig

    let tracker: TaskTrackerService
    if (config.issueSource === "linear") {
      const linearTrackerLayer = LinearTrackerLive.pipe(
        Layer.provide(LinearSdkClientLive),
        Layer.provide(Layer.succeed(LalphConfig, config))
      )
      tracker = yield* TaskTracker.pipe(Effect.provide(linearTrackerLayer))
    } else {
      const githubTrackerLayer = GitHubIssueTrackerLive.pipe(
        Layer.provide(Layer.succeed(OctokitClient, octokit))
      )
      tracker = yield* TaskTracker.pipe(Effect.provide(githubTrackerLayer))
    }

    const trackerForRepo = (repoFullName: string) =>
      repoFullName === config.repoFullName
        ? Effect.succeed(tracker)
        : Effect.fail(
          new TrackerResolverError({
            message: `No tracker configured for repo: ${repoFullName}`,
            cause: null
          })
        )

    return {
      trackerForRepo,
      allTrackers: [tracker],
      allWatchedRepos: [config.repoFullName]
    }
  })
)
