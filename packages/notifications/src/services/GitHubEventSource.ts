/**
 * GitHub event source polling service
 * @since 1.0.0
 */
import { Array, Context, Data, Duration, Effect, HashMap, HashSet, Layer, Option, Ref, Schedule, Stream } from "effect"
import { PRCommentAdded, PRConflictDetected, PROpened } from "../Events.js"
import type { AppEvent } from "../Events.js"
import { AppRuntimeConfig } from "../schemas/CredentialSchemas.js"
import type { GitHubPullRequest, GitHubRepo } from "../schemas/GitHubSchemas.js"
import { GitHubClient } from "./GitHubClient.js"
import { LalphConfig } from "./LalphConfig.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class GitHubEventSourceError extends Data.TaggedError("GitHubEventSourceError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface GitHubEventSourceService {
  readonly stream: Stream.Stream<AppEvent, GitHubEventSourceError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class GitHubEventSource extends Context.Tag("GitHubEventSource")<
  GitHubEventSource,
  GitHubEventSourceService
>() {}

interface PRWithRepo {
  readonly pr: GitHubPullRequest
  readonly repo: GitHubRepo
}

/**
 * @since 1.0.0
 * @category layers
 */
export const GitHubEventSourceLive = Layer.effect(
  GitHubEventSource,
  Effect.gen(function*() {
    const config = yield* AppRuntimeConfig
    const lalphConfig = yield* LalphConfig
    const github = yield* GitHubClient
    const interval = Duration.seconds(config.pollIntervalSeconds)

    const authenticatedUser = yield* github.getAuthenticatedUser().pipe(
      Effect.mapError((err) =>
        new GitHubEventSourceError({ message: `Failed to get authenticated user: ${String(err)}`, cause: err })
      )
    )

    const knownPRsRef = yield* Ref.make(HashSet.empty<number>())
    const conflictNotifiedRef = yield* Ref.make(HashSet.empty<number>())
    const lastCommentIdsRef = yield* Ref.make(HashMap.empty<number, number>())
    const isFirstCycleRef = yield* Ref.make(true)

    const pollCycle = Effect.gen(function*() {
      const isFirstCycle = yield* Ref.get(isFirstCycleRef)
      const knownPRs = yield* Ref.get(knownPRsRef)
      const conflictNotified = yield* Ref.get(conflictNotifiedRef)
      const lastCommentIds = yield* Ref.get(lastCommentIdsRef)

      const allRepos = yield* github.listUserRepos().pipe(
        Effect.mapError((err) =>
          new GitHubEventSourceError({ message: `Failed to list repos: ${String(err)}`, cause: err })
        )
      )

      const repos = allRepos.filter((repo) => repo.full_name === lalphConfig.repoFullName)

      const allPRsWithRepos = yield* Effect.forEach(repos, (repo) =>
        github.listOpenPRs(repo).pipe(
          Effect.map(Array.map((pr): PRWithRepo => ({ pr, repo }))),
          Effect.mapError((err) =>
            new GitHubEventSourceError({
              message: `Failed to list PRs for ${repo.full_name}: ${String(err)}`,
              cause: err
            })
          )
        )).pipe(Effect.map(Array.flatten))

      const events: Array<AppEvent> = []
      const currentPRIds = HashSet.fromIterable(allPRsWithRepos.map(({ pr }) => pr.id))

      // Detect new PRs (only emit PROpened after first cycle)
      for (const { pr } of allPRsWithRepos) {
        if (!HashSet.has(knownPRs, pr.id) && !isFirstCycle) {
          events.push(new PROpened({ pr }))
        }
      }

      // Detect conflicts (emit even on first cycle)
      for (const { pr } of allPRsWithRepos) {
        if (pr.hasConflicts && !HashSet.has(conflictNotified, pr.id)) {
          events.push(new PRConflictDetected({ pr }))
        }
      }

      // Detect new comments
      for (const { pr, repo } of allPRsWithRepos) {
        const issueComments = yield* github.listComments(repo, pr.number).pipe(
          Effect.mapError((err) =>
            new GitHubEventSourceError({
              message: `Failed to list comments for PR #${pr.number}: ${String(err)}`,
              cause: err
            })
          )
        )
        const reviewComments = yield* github.listReviewComments(repo, pr.number).pipe(
          Effect.mapError((err) =>
            new GitHubEventSourceError({
              message: `Failed to list review comments for PR #${pr.number}: ${String(err)}`,
              cause: err
            })
          )
        )
        const comments = [...issueComments, ...reviewComments]

        const filteredComments = comments.filter((c) => c.user.login === authenticatedUser.login)

        const lastId = Option.getOrElse(HashMap.get(lastCommentIds, pr.id), () => 0)
        const newComments = filteredComments.filter((c) => c.id > lastId)

        if (!isFirstCycle) {
          for (const comment of newComments) {
            events.push(new PRCommentAdded({ pr, comment }))
          }
        }

        if (filteredComments.length > 0) {
          const maxId = Math.max(...filteredComments.map((c) => c.id))
          yield* Ref.update(lastCommentIdsRef, (m) => HashMap.set(m, pr.id, maxId))
        }
      }

      // Update state
      yield* Ref.set(knownPRsRef, currentPRIds)

      const conflictedIds = HashSet.fromIterable(
        allPRsWithRepos.filter(({ pr }) => pr.hasConflicts).map(({ pr }) => pr.id)
      )
      yield* Ref.set(conflictNotifiedRef, conflictedIds)
      yield* Ref.set(isFirstCycleRef, false)

      return events
    })

    const emptyBatch: Array<AppEvent> = []

    const safePollCycle = pollCycle.pipe(
      Effect.tapError((err) => Effect.logError(`GitHubEventSource poll cycle failed: ${err.message}`)),
      Effect.orElseSucceed(() => emptyBatch)
    )

    const eventStream = Stream.repeatEffectWithSchedule(
      safePollCycle,
      Schedule.spaced(interval)
    ).pipe(
      Stream.flatMap((batch) => Stream.fromIterable(batch))
    )

    return GitHubEventSource.of({ stream: eventStream })
  })
)
