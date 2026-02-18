/**
 * Auto-merge service that evaluates open PRs for automatic merging
 * @since 1.0.0
 */
import { Array, Context, Data, Effect, HashMap, HashSet, Layer, Option, Ref } from "effect"
import { PRAutoMerged, PRCIFailed } from "../Events.js"
import type { AppEvent } from "../Events.js"
import type { GitHubPullRequest } from "../schemas/GitHubSchemas.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { AppRuntimeConfig } from "./AppRuntimeConfig.js"
import { GitHubClient } from "./GitHubClient.js"

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
  readonly evaluatePRs: (
    prs: ReadonlyArray<GitHubPullRequest>
  ) => Effect.Effect<ReadonlyArray<AppEvent>, AutoMergeError>
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

const isCIFailed = (state: string, checkRuns: ReadonlyArray<{ readonly conclusion: string | null }>) => {
  const anyCheckFailed = Array.some(
    checkRuns,
    (cr) => cr.conclusion !== null && cr.conclusion !== "success" && cr.conclusion !== "skipped"
  )
  return state === "failure" || anyCheckFailed
}

/**
 * @since 1.0.0
 * @category layers
 */
export const AutoMergeLive = Layer.effect(
  AutoMerge,
  Effect.gen(function*() {
    const config = yield* AppRuntimeConfig
    const github = yield* GitHubClient

    // headShaTimestamps: tracks when we first saw each PR's current head SHA (PR number -> { sha, timestamp })
    const headShaTimestampsRef = yield* Ref.make(HashMap.empty<number, { sha: string; timestamp: number }>())
    // failureNotified: tracks which SHA we last notified a CI failure for (PR number -> sha)
    const failureNotifiedRef = yield* Ref.make(HashMap.empty<number, string>())
    // mergedPRs: set of PR numbers we've already merged
    const mergedPRsRef = yield* Ref.make(HashSet.empty<number>())

    const evaluatePRs = (prs: ReadonlyArray<GitHubPullRequest>) =>
      Effect.gen(function*() {
        if (!config.autoMergeEnabled) {
          return [] satisfies ReadonlyArray<AppEvent>
        }

        const events: Array<AppEvent> = []
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
                  [] satisfies ReadonlyArray<AppEvent>
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
        yield* Ref.update(failureNotifiedRef, (m) =>
          HashMap.filter(m, (_, prNumber) =>
            HashSet.has(currentPRNumbers, prNumber)))
        yield* Ref.update(mergedPRsRef, (s) =>
          HashSet.filter(s, (prNumber) =>
            HashSet.has(currentPRNumbers, prNumber)))

        return events
      }).pipe(
        Effect.mapError((err) =>
          new AutoMergeError({ message: `AutoMerge evaluation failed: ${String(err)}`, cause: err })
        ),
        Effect.annotateLogs("service", "AutoMerge")
      )

    const evaluateSinglePR = (pr: GitHubPullRequest) =>
      Effect.gen(function*() {
        const events: Array<AppEvent> = []
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
          // Reset failure notification if SHA changed (not first time)
          if (Option.isSome(existingEntry)) {
            yield* Ref.update(failureNotifiedRef, (m) => HashMap.remove(m, pr.number))
          }
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

        if (isCIFailed(ciStatus.state, ciStatus.checkRuns)) {
          // Post failure comment if not already notified for this SHA
          const failureNotified = yield* Ref.get(failureNotifiedRef)
          const notifiedSha = HashMap.get(failureNotified, pr.number)
          const alreadyNotified = Option.isSome(notifiedSha) && notifiedSha.value === currentSha

          if (!alreadyNotified) {
            const failedChecks = Array.filter(
              ciStatus.checkRuns,
              (cr) => cr.conclusion !== null && cr.conclusion !== "success" && cr.conclusion !== "skipped"
            )

            const failedCheckNames = Array.map(failedChecks, (cr) => `- ${cr.name}: ${cr.conclusion}`).join("\n")
            yield* github.postComment(
              repo,
              pr.number,
              `CI checks failed for this PR:\n${failedCheckNames}`
            )

            yield* Ref.update(failureNotifiedRef, (m) => HashMap.set(m, pr.number, currentSha))

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

          return events
        }

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

    return AutoMerge.of({ evaluatePRs })
  })
)
