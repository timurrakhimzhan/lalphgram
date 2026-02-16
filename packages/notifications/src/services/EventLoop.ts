/**
 * Event loop and layer construction for the notification service
 * @since 1.0.0
 */
import { Console, Effect, Layer, Match, Option, Stream } from "effect"
import type { AppEvent } from "../Events.js"
import { BranchParser, BranchParserLive } from "../lib/BranchParser.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { CommentTimer, CommentTimerLive } from "./CommentTimer.js"
import { GitHubClient, GitHubClientLive } from "./GitHubClient.js"
import { GitHubEventSource, GitHubEventSourceLive } from "./GitHubEventSource.js"
import { LalphConfig, LalphConfigLive } from "./LalphConfig.js"
import { MessengerAdapter } from "./MessengerAdapter.js"
import { OctokitClientLive } from "./OctokitClient.js"
import { TaskEventSource, TaskEventSourceLive } from "./TaskEventSource.js"
import { TaskTracker } from "./TaskTracker.js"
import { TelegramAdapterLive } from "./TelegramAdapter.js"
import { TrackerLayerMap } from "./TrackerLayerMap.js"

const lalphConfigLayer = LalphConfigLive

const octokitLayer = OctokitClientLive.pipe(
  Layer.provide(lalphConfigLayer)
)

const telegramAdapterLayer = TelegramAdapterLive

const trackerLayerMapLayer = TrackerLayerMap.Default.pipe(
  Layer.provide(octokitLayer),
  Layer.provide(lalphConfigLayer)
)

const taskTrackerLayer = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* LalphConfig
    return TrackerLayerMap.get(config.issueSource)
  })
).pipe(
  Layer.provide(trackerLayerMapLayer),
  Layer.provide(lalphConfigLayer)
)

const servicesLayer = Layer.mergeAll(
  GitHubClientLive,
  telegramAdapterLayer,
  taskTrackerLayer
).pipe(
  Layer.provide(octokitLayer)
)

const eventSourcesLayer = Layer.mergeAll(
  GitHubEventSourceLive,
  TaskEventSourceLive
).pipe(
  Layer.provide(servicesLayer),
  Layer.provide(lalphConfigLayer)
)

const branchParserLayer = BranchParserLive

const commentTimerLayer = CommentTimerLive.pipe(
  Layer.provide(servicesLayer),
  Layer.provide(branchParserLayer)
)

/**
 * The main layer providing all services for the event loop.
 * Requires AppRuntimeConfig and TelegramConfigStore to be provided externally.
 * @since 1.0.0
 * @category layers
 */
export const MainLayer = Layer.mergeAll(
  lalphConfigLayer,
  servicesLayer,
  eventSourcesLayer,
  commentTimerLayer,
  branchParserLayer
)

/**
 * The main event loop that merges all event streams and dispatches events
 * @since 1.0.0
 * @category event-loop
 */
export const runEventLoop = Effect.gen(function*() {
  const githubEvents = yield* GitHubEventSource
  const taskEvents = yield* TaskEventSource
  const notifier = yield* MessengerAdapter
  const github = yield* GitHubClient
  const timer = yield* CommentTimer
  const tracker = yield* TaskTracker
  const branchParser = yield* BranchParser

  const dispatchEvent = (event: AppEvent) =>
    Match.value(event).pipe(
      Match.tag("TaskCreated", (e) =>
        notifier.sendMessage(`📋 <b>New task created</b>\n<a href="${e.issue.url}">${e.issue.title}</a>`)),
      Match.tag("TaskUpdated", (e) =>
        notifier.sendMessage(
          `✏️ <b>Task moved to ${e.issue.state}</b>\n<a href="${e.issue.url}">${e.issue.title}</a>\n${e.previousState} → ${e.issue.state}`
        )),
      Match.tag("PROpened", (e) =>
        notifier.sendMessage(`🔀 <b>New PR opened</b>\n<a href="${e.pr.html_url}">${e.pr.title}</a>`)),
      Match.tag("PRConflictDetected", (e) =>
        Effect.gen(function*() {
          yield* github.postComment(
            new GitHubRepo({
              id: 0,
              name: "",
              full_name: e.pr.repo,
              owner: { login: "" },
              html_url: ""
            }),
            e.pr.number,
            "This PR has merge conflicts that need to be resolved."
          )
          const issueIdOption = branchParser.resolveIssueId(e.pr)
          if (Option.isSome(issueIdOption)) {
            const issueId = issueIdOption.value
            yield* tracker.moveToTodo(issueId).pipe(
              Effect.tapError((err) =>
                Effect.logError(`Failed to move to todo: ${err.message}`)
              ),
              Effect.orElseSucceed(() =>
                undefined
              )
            )
            yield* tracker.setPriorityUrgent(issueId).pipe(
              Effect.tapError((err) => Effect.logError(`Failed to set priority: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
          } else {
            yield* Effect.logWarning("No issue ID found in branch name").pipe(
              Effect.annotateLogs("branch", e.pr.headRef)
            )
          }
          yield* notifier.sendMessage(
            `⚠️ <b>Conflict detected</b>\n<a href="${e.pr.html_url}">${e.pr.title}</a>`
          )
        })),
      Match.tag("PRCommentAdded", (e) =>
        timer.handleComment(e.pr, e.comment).pipe(
          Effect.tapError((err) => Effect.logError(`Comment timer error: ${err.message}`)),
          Effect.orElseSucceed(() => undefined)
        )),
      Match.exhaustive
    )

  const mergedStream = Stream.merge(
    githubEvents.stream,
    taskEvents.stream
  )

  yield* Console.log("Notification service started. Press Ctrl+C to stop.")

  yield* mergedStream.pipe(
    Stream.runForEach((event) =>
      dispatchEvent(event).pipe(
        Effect.catchAll((err) => Effect.logError(`Event dispatch error: ${String(err)}`))
      )
    ),
    Effect.ensuring(
      timer.shutdown.pipe(
        Effect.tapError((err) => Effect.logError(`Shutdown error: ${err.message}`)),
        Effect.orElseSucceed(() => undefined)
      )
    ),
    Effect.annotateLogs("service", "EventLoop"),
    Effect.catchAll((err) => Effect.logError(`Event loop error: ${String(err)}`))
  )
})
