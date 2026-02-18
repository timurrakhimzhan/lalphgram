/**
 * Event loop and layer construction for the notification service
 * @since 1.0.0
 */
import { Console, Effect, Layer, Match, Option, Ref, Stream } from "effect"
import type { AppEvent } from "../Events.js"
import { BranchParser, BranchParserLive } from "../lib/BranchParser.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { AutoMergeLive } from "./AutoMerge.js"
import { CommentTimer, CommentTimerLive } from "./CommentTimer.js"
import { GitHubClient, GitHubClientLive } from "./GitHubClient.js"
import { GitHubEventSource, GitHubEventSourceLive } from "./GitHubEventSource.js"
import { LalphConfig, LalphConfigLive } from "./LalphConfig.js"
import { MessengerAdapter } from "./MessengerAdapter/MessengerAdapter.js"
import { TelegramAdapterLive } from "./MessengerAdapter/TelegramAdapter.js"
import { OctokitClientLive } from "./OctokitClient.js"
import { PlanSession, PlanSessionLive } from "./PlanSession.js"
import { TaskEventSource, TaskEventSourceLive } from "./TaskEventSource.js"
import { TaskTracker } from "./TaskTracker/TaskTracker.js"
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

const autoMergeLayer = AutoMergeLive.pipe(
  Layer.provide(servicesLayer)
)

const eventSourcesLayer = Layer.mergeAll(
  GitHubEventSourceLive,
  TaskEventSourceLive
).pipe(
  Layer.provide(autoMergeLayer),
  Layer.provide(servicesLayer),
  Layer.provide(lalphConfigLayer)
)

const branchParserLayer = BranchParserLive

const commentTimerLayer = CommentTimerLive.pipe(
  Layer.provide(servicesLayer),
  Layer.provide(branchParserLayer)
)

const planSessionLayer = PlanSessionLive.pipe(
  Layer.provide(lalphConfigLayer)
)

/**
 * The main layer providing all services for the event loop.
 * Requires AppRuntimeConfig, TelegramConfigStore, and PlanCommandBuilder to be provided externally.
 * @since 1.0.0
 * @category layers
 */
export const MainLayer = Layer.mergeAll(
  lalphConfigLayer,
  servicesLayer,
  eventSourcesLayer,
  commentTimerLayer,
  branchParserLayer,
  planSessionLayer
)

/**
 * The main event loop that merges all event streams and dispatches events
 * @since 1.0.0
 * @category event-loop
 */
export const PLAN_BUTTON_LABEL = "Plan"
const DONE_BUTTON_LABEL = "Done"

export const runEventLoop = Effect.gen(function*() {
  const githubEvents = yield* GitHubEventSource
  const taskEvents = yield* TaskEventSource
  const notifier = yield* MessengerAdapter
  const github = yield* GitHubClient
  const timer = yield* CommentTimer
  const tracker = yield* TaskTracker
  const branchParser = yield* BranchParser
  const planSession = yield* PlanSession

  const collectingPlan = yield* Ref.make(false)
  const planBuffer = yield* Ref.make<ReadonlyArray<string>>([])

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
      Match.tag("PRAutoMerged", (e) =>
        notifier.sendMessage(
          `✅ <b>PR auto-merged</b>\n<a href="${e.pr.html_url}">${e.pr.title}</a>`
        )),
      Match.tag("PRCIFailed", (e) =>
        Effect.gen(function*() {
          const issueIdOption = branchParser.resolveIssueId(e.pr)
          if (Option.isSome(issueIdOption)) {
            const issueId = issueIdOption.value
            yield* tracker.moveToTodo(issueId).pipe(
              Effect.tapError((err) => Effect.logError(`Failed to move to todo: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
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
          const failedCheckNames = e.failedChecks.map((c) => c.name).join(", ")
          yield* notifier.sendMessage(
            `❌ <b>CI failed</b>\n<a href="${e.pr.html_url}">${e.pr.title}</a>\nFailed checks: ${failedCheckNames}`
          )
        })),
      Match.exhaustive
    )

  const handleIncomingMessage = (msg: { text: string }) =>
    Effect.gen(function*() {
      yield* Effect.log(`Incoming message: ${msg.text}`)
      if (msg.text === PLAN_BUTTON_LABEL) {
        yield* Effect.log("Plan collection started")
        yield* Ref.set(collectingPlan, true)
        yield* Ref.set(planBuffer, [])
        yield* notifier.sendMessage({
          text: "Describe what you'd like to plan. Send your messages, then tap <b>Done</b> when ready.",
          replyKeyboard: [{ label: DONE_BUTTON_LABEL }]
        })
        return
      }
      const isCollecting = yield* Ref.get(collectingPlan)
      if (msg.text === DONE_BUTTON_LABEL && isCollecting) {
        const messages = yield* Ref.get(planBuffer)
        yield* Ref.set(collectingPlan, false)
        yield* Ref.set(planBuffer, [])
        const joinedText = messages.join("\n")
        if (joinedText.trim().length === 0) {
          yield* Effect.log("Plan collection done with empty buffer")
          yield* notifier.sendMessage("No plan description provided.")
          return
        }
        yield* Effect.log("Plan collection done, starting session").pipe(
          Effect.annotateLogs("planText", joinedText)
        )
        yield* planSession.start(joinedText).pipe(
          Effect.tapError((err) => notifier.sendMessage(`Plan error: ${err.message}`)),
          Effect.orElseSucceed(() => undefined)
        )
        yield* notifier.sendMessage("Planning started...")
        return
      }
      if (isCollecting) {
        yield* Effect.log("Buffering plan message").pipe(
          Effect.annotateLogs("bufferedText", msg.text)
        )
        yield* Ref.update(planBuffer, (buf) => [...buf, msg.text])
        return
      }
      const active = yield* planSession.isActive
      if (active) {
        yield* Effect.log("Forwarding answer to plan session")
        yield* planSession.answer(msg.text).pipe(
          Effect.tapError((err) => Effect.logError(`Plan answer error: ${err.message}`)),
          Effect.orElseSucceed(() => undefined)
        )
      }
    }).pipe(Effect.annotateLogs("service", "PlanInput"))

  const incomingMessageStream = notifier.incomingMessages.pipe(
    Stream.mapEffect((msg) =>
      handleIncomingMessage(msg).pipe(
        Effect.catchAll((err) => Effect.logError(`Incoming message error: ${String(err)}`))
      )
    )
  )

  const planEventStream = planSession.events.pipe(
    Stream.mapEffect((event) =>
      Match.value(event).pipe(
        Match.tag("PlanTextOutput", (e) => notifier.sendMessage(e.text.slice(0, 4096))),
        Match.tag("PlanQuestion", (e) =>
          Effect.forEach(e.questions, (q) =>
            notifier.sendMessage({
              text: q.question,
              options: q.options?.map((o) => ({ label: o.label }))
            }))),
        Match.tag("PlanCompleted", () => notifier.sendMessage("Plan completed.")),
        Match.tag("PlanFailed", (e) => notifier.sendMessage(`Plan failed: ${e.message}`)),
        Match.exhaustive
      ).pipe(
        Effect.catchAll((err) => Effect.logError(`Plan event relay error: ${String(err)}`))
      )
    )
  )

  const mergedStream = Stream.merge(
    githubEvents.stream,
    taskEvents.stream
  )

  yield* notifier.sendMessage({
    text: "🚀 Notification service started.",
    replyKeyboard: [{ label: PLAN_BUTTON_LABEL }]
  })
  yield* Console.log("🚀 Notification service started. Press Ctrl+C to stop.")

  yield* Stream.merge(
    incomingMessageStream,
    planEventStream
  ).pipe(
    Stream.runDrain,
    Effect.annotateLogs("service", "PlanSession"),
    Effect.catchAll((err) => Effect.logError(`Plan stream error: ${String(err)}`)),
    Effect.forkDaemon
  )

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
