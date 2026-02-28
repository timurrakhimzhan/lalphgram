/**
 * GitHub event source polling service
 * @since 1.0.0
 */
import { Array, Context, Data, Duration, Effect, HashMap, HashSet, Layer, Option, Ref, Schedule, Stream } from "effect"
import { PRCIFailed, PRCommentAdded, PRConflictDetected, PROpened } from "../Events.js"
import type { PullRequestEvent } from "../Events.js"
import type { GitHubPullRequest, GitHubRepo } from "../schemas/GitHubSchemas.js"
import { GitHubRepo as GitHubRepoClass } from "../schemas/GitHubSchemas.js"
import { AppRuntimeConfig } from "./AppRuntimeConfig.js"
import { GitHubClient, isBillingFailure } from "./GitHubClient.js"
import { LalphConfig } from "./LalphConfig.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class PullRequestTrackerError extends Data.TaggedError("PullRequestTrackerError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface PullRequestTrackerService {
  readonly eventStream: Stream.Stream<PullRequestEvent, PullRequestTrackerError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class PullRequestTracker extends Context.Tag("PullRequestTracker")<
  PullRequestTracker,
  PullRequestTrackerService
>() {}

interface PRWithRepo {
  readonly pr: GitHubPullRequest
  readonly repo: GitHubRepo
}

const makeRepoFromFullName = (fullName: string) =>
  new GitHubRepoClass({
    id: 0,
    name: "",
    full_name: fullName,
    owner: { login: "" },
    html_url: ""
  })

const isCIFailed = (
  state: string,
  checkRuns: ReadonlyArray<{
    readonly conclusion: string | null
    readonly output: { readonly summary: string | null } | null
    readonly annotationMessages: ReadonlyArray<string>
  }>
) => {
  const nonBillingRuns = Array.filter(checkRuns, (cr) => !isBillingFailure(cr))
  const anyCheckFailed = Array.some(
    nonBillingRuns,
    (cr) => cr.conclusion !== null && cr.conclusion !== "success" && cr.conclusion !== "skipped"
  )
  return (state === "failure" && nonBillingRuns.length > 0) || anyCheckFailed
}

/**
 * @since 1.0.0
 * @category layers
 */
export const PullRequestTrackerLive = Layer.effect(
  PullRequestTracker,
  Effect.gen(function*() {
    const config = yield* AppRuntimeConfig
    const lalphConfig = yield* LalphConfig
    const github = yield* GitHubClient
    const interval = Duration.seconds(config.pollIntervalSeconds)

    const authenticatedUser = yield* github.getAuthenticatedUser().pipe(
      Effect.mapError((err) =>
        new PullRequestTrackerError({ message: `Failed to get authenticated user: ${String(err)}`, cause: err })
      )
    )

    const knownPRsRef = yield* Ref.make(HashSet.empty<number>())
    const conflictNotifiedRef = yield* Ref.make(HashSet.empty<number>())
    const lastCommentIdsRef = yield* Ref.make(HashMap.empty<number, number>())
    const failureNotifiedRef = yield* Ref.make(HashMap.empty<number, string>())
    const isFirstCycleRef = yield* Ref.make(true)

    const pollCycle = Effect.gen(function*() {
      const isFirstCycle = yield* Ref.get(isFirstCycleRef)
      const knownPRs = yield* Ref.get(knownPRsRef)
      const conflictNotified = yield* Ref.get(conflictNotifiedRef)
      const lastCommentIds = yield* Ref.get(lastCommentIdsRef)

      const allRepos = yield* github.listUserRepos().pipe(
        Effect.mapError((err) =>
          new PullRequestTrackerError({ message: `Failed to list repos: ${String(err)}`, cause: err })
        )
      )

      const repos = allRepos.filter((repo) => repo.full_name === lalphConfig.repoFullName)

      const allPRsWithRepos = yield* Effect.forEach(repos, (repo) =>
        github.listOpenPRs(repo).pipe(
          Effect.map(Array.map((pr): PRWithRepo => ({ pr, repo }))),
          Effect.mapError((err) =>
            new PullRequestTrackerError({
              message: `Failed to list PRs for ${repo.full_name}: ${String(err)}`,
              cause: err
            })
          )
        )).pipe(Effect.map(Array.flatten))

      const events: Array<PullRequestEvent> = []
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
            new PullRequestTrackerError({
              message: `Failed to list comments for PR #${pr.number}: ${String(err)}`,
              cause: err
            })
          )
        )
        const reviewComments = yield* github.listReviewComments(repo, pr.number).pipe(
          Effect.mapError((err) =>
            new PullRequestTrackerError({
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

      // Detect CI failures
      for (const { pr } of allPRsWithRepos) {
        const repo = makeRepoFromFullName(pr.repo)
        const ciStatus = yield* github.getCIStatus(repo, pr.headSha).pipe(
          Effect.mapError((err) =>
            new PullRequestTrackerError({
              message: `Failed to get CI status for PR #${pr.number}: ${String(err)}`,
              cause: err
            })
          )
        )

        if (isCIFailed(ciStatus.state, ciStatus.checkRuns)) {
          const failureNotified = yield* Ref.get(failureNotifiedRef)
          const notifiedSha = HashMap.get(failureNotified, pr.number)
          const alreadyNotified = Option.isSome(notifiedSha) && notifiedSha.value === pr.headSha

          if (!alreadyNotified) {
            const failedChecks = Array.filter(
              ciStatus.checkRuns,
              (cr) =>
                cr.conclusion !== null && cr.conclusion !== "success" && cr.conclusion !== "skipped" &&
                !isBillingFailure(cr)
            )

            const failedCheckNames = Array.map(failedChecks, (cr) => `- ${cr.name}: ${cr.conclusion}`).join("\n")
            yield* github.postComment(
              repo,
              pr.number,
              `CI checks failed for this PR:\n${failedCheckNames}`
            ).pipe(
              Effect.mapError((err) =>
                new PullRequestTrackerError({
                  message: `Failed to post CI failure comment for PR #${pr.number}: ${String(err)}`,
                  cause: err
                })
              )
            )

            yield* Ref.update(failureNotifiedRef, (m) => HashMap.set(m, pr.number, pr.headSha))

            events.push(
              new PRCIFailed({
                pr,
                failedChecks: Array.map(failedChecks, (cr) => ({
                  name: cr.name,
                  html_url: cr.html_url,
                  conclusion: cr.conclusion ?? "unknown"
                }))
              })
            )
          }
        }
      }

      // Update state
      yield* Ref.set(knownPRsRef, currentPRIds)

      const conflictedIds = HashSet.fromIterable(
        allPRsWithRepos.filter(({ pr }) => pr.hasConflicts).map(({ pr }) => pr.id)
      )
      yield* Ref.set(conflictNotifiedRef, conflictedIds)

      const currentPRNumbers = HashSet.fromIterable(allPRsWithRepos.map(({ pr }) => pr.number))
      yield* Ref.update(
        failureNotifiedRef,
        (m) => HashMap.filter(m, (_, prNumber) => HashSet.has(currentPRNumbers, prNumber))
      )

      yield* Ref.set(isFirstCycleRef, false)

      return events
    })

    const emptyBatch: Array<PullRequestEvent> = []

    const safePollCycle = pollCycle.pipe(
      Effect.tapError((err) => Effect.logError(`PullRequestTracker poll cycle failed: ${err.message}`)),
      Effect.orElseSucceed(() => emptyBatch)
    )

    const eventStream = Stream.repeatEffectWithSchedule(
      safePollCycle,
      Schedule.spaced(interval)
    ).pipe(
      Stream.flatMap((batch) => Stream.fromIterable(batch))
    )

    return PullRequestTracker.of({ eventStream })
  })
)
