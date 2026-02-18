/**
 * Auto-merge service that evaluates open PRs for automatic merging
 * @since 1.0.0
 */
import { Array, Context, Data, Duration, Effect, HashMap, HashSet, Layer, Option, Ref, Schedule, Stream } from "effect"
import { PRAutoMerged } from "../Events.js"
import type { AutoMergeEvent } from "../Events.js"
import type { GitHubPullRequest } from "../schemas/GitHubSchemas.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { AppRuntimeConfig } from "./AppRuntimeConfig.js"
import { GitHubClient } from "./GitHubClient.js"
import { LalphConfig } from "./LalphConfig.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class AutoMergeError extends Data.TaggedError("AutoMergeError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface AutoMergeService {
  readonly eventStream: Stream.Stream<AutoMergeEvent, AutoMergeError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class AutoMerge extends Context.Tag("AutoMerge")<AutoMerge, AutoMergeService>() {}

const makeRepoFromFullName = (fullName: string) =>
  new GitHubRepo({
    id: 0,
    name: "",
    full_name: fullName,
    owner: { login: "" },
    html_url: ""
  })

const isCISuccess = (state: string, checkRuns: ReadonlyArray<{ readonly conclusion: string | null }>) => {
  if (checkRuns.length === 0) return state === "success"
  const allChecksCompleted = Array.every(checkRuns, (cr) => cr.conclusion !== null)
  const allChecksPassed = Array.every(checkRuns, (cr) => cr.conclusion === "success" || cr.conclusion === "skipped")
  return allChecksCompleted && allChecksPassed && state !== "failure"
}

/**
 * @since 1.0.0
 * @category layers
 */
export const AutoMergeLive = Layer.effect(
  AutoMerge,
  Effect.gen(function*() {
    const config = yield* AppRuntimeConfig
    const lalphConfig = yield* LalphConfig
    const github = yield* GitHubClient
    const interval = Duration.seconds(config.pollIntervalSeconds)

    // headShaTimestamps: tracks when we first saw each PR's current head SHA (PR number -> { sha, timestamp })
    const headShaTimestampsRef = yield* Ref.make(HashMap.empty<number, { sha: string; timestamp: number }>())
    // mergedPRs: set of PR numbers we've already merged
    const mergedPRsRef = yield* Ref.make(HashSet.empty<number>())

    const evaluatePRs = (prs: ReadonlyArray<GitHubPullRequest>) =>
      Effect.gen(function*() {
        if (!config.autoMergeEnabled) {
          return [] satisfies ReadonlyArray<AutoMergeEvent>
        }

        const events: Array<AutoMergeEvent> = []
        const currentPRNumbers = HashSet.fromIterable(Array.map(prs, (pr) => pr.number))
        const mergedPRs = yield* Ref.get(mergedPRsRef)

        for (const pr of prs) {
          if (HashSet.has(mergedPRs, pr.number)) {
            continue
          }

          if (pr.hasConflicts) {
            continue
          }

          const prEvents = yield* evaluateSinglePR(pr).pipe(
            Effect.catchTag("GitHubClientError", (err) =>
              Effect.logError(`AutoMerge evaluation failed for PR #${pr.number}`).pipe(
                Effect.annotateLogs("error", err.message),
                Effect.map(() =>
                  [] satisfies ReadonlyArray<AutoMergeEvent>
                )
              ))
          )

          for (const event of prEvents) {
            events.push(event)
          }
        }

        // Clean up state for PRs no longer open
        yield* Ref.update(headShaTimestampsRef, (m) =>
          HashMap.filter(m, (_, prNumber) =>
            HashSet.has(currentPRNumbers, prNumber)))
        yield* Ref.update(mergedPRsRef, (s) =>
          HashSet.filter(s, (prNumber) => HashSet.has(currentPRNumbers, prNumber)))

        return events
      }).pipe(
        Effect.mapError((err) =>
          new AutoMergeError({ message: `AutoMerge evaluation failed: ${String(err)}`, cause: err })
        ),
        Effect.annotateLogs("service", "AutoMerge")
      )

    const evaluateSinglePR = (pr: GitHubPullRequest) =>
      Effect.gen(function*() {
        const events: Array<AutoMergeEvent> = []
        const repo = makeRepoFromFullName(pr.repo)
        const now = Date.now()

        // Update SHA timestamps
        const headShaTimestamps = yield* Ref.get(headShaTimestampsRef)
        const existingEntry = HashMap.get(headShaTimestamps, pr.number)
        const currentSha = pr.headSha

        const shaChanged = Option.isNone(existingEntry) ||
          existingEntry.value.sha !== currentSha

        if (shaChanged) {
          yield* Ref.update(headShaTimestampsRef, (m) => HashMap.set(m, pr.number, { sha: currentSha, timestamp: now }))
        }

        const shaEntry = yield* Ref.get(headShaTimestampsRef).pipe(
          Effect.map((m) => HashMap.get(m, pr.number))
        )
        if (Option.isNone(shaEntry)) {
          return events
        }

        const waitMs = config.autoMergeWaitMinutes * 60 * 1000
        const elapsed = now - shaEntry.value.timestamp

        // Get CI status
        const ciStatus = yield* github.getCIStatus(repo, currentSha)

        if (isCISuccess(ciStatus.state, ciStatus.checkRuns)) {
          if (elapsed < waitMs) {
            return events
          }

          // Merge the PR
          yield* github.mergePR(repo, pr.number)
          yield* Ref.update(mergedPRsRef, (s) => HashSet.add(s, pr.number))

          events.push(new PRAutoMerged({ pr }))
        }

        return events
      })

    const pollCycle = Effect.gen(function*() {
      const allRepos = yield* github.listUserRepos().pipe(
        Effect.mapError((err) => new AutoMergeError({ message: `Failed to list repos: ${String(err)}`, cause: err }))
      )

      const repos = allRepos.filter((repo) => repo.full_name === lalphConfig.repoFullName)

      const allPRs = yield* Effect.forEach(repos, (repo) =>
        github.listOpenPRs(repo).pipe(
          Effect.mapError((err) =>
            new AutoMergeError({ message: `Failed to list PRs for ${repo.full_name}: ${String(err)}`, cause: err })
          )
        )).pipe(Effect.map(Array.flatten))

      return yield* evaluatePRs(allPRs)
    })

    const emptyBatch: Array<AutoMergeEvent> = []

    const safePollCycle = pollCycle.pipe(
      Effect.tapError((err) => Effect.logError(`AutoMerge poll cycle failed: ${err.message}`)),
      Effect.orElseSucceed(() => emptyBatch)
    )

    const eventStream = Stream.repeatEffectWithSchedule(
      safePollCycle,
      Schedule.spaced(interval)
    ).pipe(
      Stream.flatMap((batch) => Stream.fromIterable(batch))
    )

    return AutoMerge.of({ eventStream })
  })
)
