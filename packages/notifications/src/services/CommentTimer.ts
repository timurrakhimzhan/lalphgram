/**
 * Comment timer debounce service for per-PR timer management
 * @since 1.0.0
 */
import { Context, Data, Duration, Effect, Fiber, HashMap, Layer, Option, Ref } from "effect"
import { extractIssueId } from "../lib/BranchParser.js"
import { AppRuntimeConfig } from "../schemas/CredentialSchemas.js"
import type { GitHubComment, GitHubPullRequest } from "../schemas/GitHubSchemas.js"
import { MessengerAdapter } from "./MessengerAdapter.js"
import { TaskTracker } from "./TaskTracker.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class CommentTimerError extends Data.TaggedError("CommentTimerError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface CommentTimerService {
  readonly handleComment: (
    pr: GitHubPullRequest,
    comment: GitHubComment
  ) => Effect.Effect<void, CommentTimerError>
  readonly shutdown: Effect.Effect<void, CommentTimerError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class CommentTimer extends Context.Tag("CommentTimer")<CommentTimer, CommentTimerService>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const CommentTimerLive = Layer.effect(
  CommentTimer,
  Effect.gen(function*() {
    const config = yield* AppRuntimeConfig
    const tracker = yield* TaskTracker
    const notifier = yield* MessengerAdapter

    const timersRef = yield* Ref.make(HashMap.empty<string, Fiber.RuntimeFiber<void, never>>())

    const prKey = (pr: GitHubPullRequest) => `${pr.repo}#${pr.number}`

    const handleComment = (pr: GitHubPullRequest, comment: GitHubComment) =>
      Effect.gen(function*() {
        const issueIdOption = extractIssueId(pr.headRef)

        if (Option.isNone(issueIdOption)) {
          yield* Effect.logWarning("No issue ID found in branch name").pipe(
            Effect.annotateLogs("service", "CommentTimer"),
            Effect.annotateLogs("branch", pr.headRef)
          )
          return
        }

        const issueId = issueIdOption.value
        const key = prKey(pr)
        const keyword = config.triggerKeyword

        if (comment.body.toLowerCase().includes(keyword.toLowerCase())) {
          yield* tracker.moveToTodo(issueId).pipe(
            Effect.tapError((err) => Effect.logError(`Failed to move issue to todo: ${err.message}`)),
            Effect.orElseSucceed(() => undefined)
          )
          yield* notifier.sendMessage(
            `🚨 <b>Keyword "${keyword}" detected</b>\nComment on <a href="${pr.html_url}">${pr.title}</a> — moved <code>${issueId}</code> to Todo`
          ).pipe(
            Effect.tapError((err) => Effect.logError(`Failed to send Telegram notification: ${err.message}`)),
            Effect.orElseSucceed(() => undefined)
          )
          return
        }

        const existingTimers = yield* Ref.get(timersRef)
        const existingFiber = HashMap.get(existingTimers, key)
        if (Option.isSome(existingFiber)) {
          yield* Fiber.interrupt(existingFiber.value)
        }

        const timerFiber = yield* Effect.sleep(Duration.seconds(config.timerDelaySeconds)).pipe(
          Effect.flatMap(() =>
            Effect.gen(function*() {
              yield* tracker.moveToTodo(issueId)
              yield* notifier.sendMessage(
                `⏰ <b>Timer expired</b>\n<a href="${pr.html_url}">${pr.title}</a> — moved <code>${issueId}</code> to Todo`
              )
            })
          ),
          Effect.tapError((err) => Effect.logError(`Timer fiber error: ${String(err)}`)),
          Effect.orElseSucceed(() => undefined),
          Effect.ensuring(
            Ref.update(timersRef, (m) => HashMap.remove(m, key))
          ),
          Effect.fork
        )

        yield* Ref.update(timersRef, (m) => HashMap.set(m, key, timerFiber))
      }).pipe(
        Effect.mapError((err) =>
          new CommentTimerError({
            message: `Failed to handle comment: ${String(err)}`,
            cause: err
          })
        )
      )

    const shutdown = Effect.gen(function*() {
      const timers = yield* Ref.get(timersRef)
      yield* Fiber.interruptAll(HashMap.values(timers))
      yield* Ref.set(timersRef, HashMap.empty())
    }).pipe(
      Effect.mapError((err) =>
        new CommentTimerError({
          message: `Failed to shutdown: ${String(err)}`,
          cause: err
        })
      )
    )

    return CommentTimer.of({ handleComment, shutdown })
  })
)
