/**
 * Event loop and layer construction for the notification service
 * @since 1.0.0
 */
import * as Machine from "@effect/experimental/Machine"
import { Console, Effect, Layer, Match, Option, Stream } from "effect"
import type { AppEvent } from "../Events.js"
import { BranchParser, BranchParserLive } from "../lib/BranchParser.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { AutoMerge, AutoMergeLive } from "./AutoMerge.js"
import {
  chatMachine,
  IDLE_KEYBOARD,
  PlanAnalysisReadyReq,
  PlanAwaitingInputReq,
  PlanCompletedReq,
  PlanFailedReq,
  PlanQuestionReceived,
  PlanSpecCreatedReq,
  PlanSpecUpdatedReq,
  PlanTextOutput,
  UserMessage
} from "./ChatMachine.js"
import { CommentTimer, CommentTimerLive } from "./CommentTimer.js"
import { GitHubClient, GitHubClientLive } from "./GitHubClient.js"
import { LalphConfig, LalphConfigLive } from "./LalphConfig.js"
import { MessengerAdapter } from "./MessengerAdapter/MessengerAdapter.js"
import { TelegramAdapterLive } from "./MessengerAdapter/TelegramAdapter.js"
import { OctokitClientLive } from "./OctokitClient.js"
import { PlanOverviewUploaderMap } from "./PlanOverviewUploaderMap.js"
import { PlanSession, PlanSessionLive } from "./PlanSession.js"
import { ProjectStoreLive } from "./ProjectStore.js"
import { PullRequestTracker, PullRequestTrackerLive } from "./PullRequestTracker.js"
import { TaskTracker } from "./TaskTracker/TaskTracker.js"
import { TrackerLayerMap } from "./TrackerLayerMap.js"

// Re-export button labels from ChatMachine for backwards compatibility
export {
  ABORT_BUTTON_LABEL,
  APPROVE_BUTTON_LABEL,
  BUFFER_BUTTON_LABEL,
  BUG_BUTTON_LABEL,
  DISCARD_BUTTON_LABEL,
  FEATURE_BUTTON_LABEL,
  INTERRUPT_BUTTON_LABEL,
  NEW_PROJECT_BUTTON_LABEL,
  OTHER_BUTTON_LABEL,
  PLAN_BUTTON_LABEL,
  REFACTOR_BUTTON_LABEL
} from "./ChatMachine.js"

// ── Layer composition (unchanged) ────────────────────────────────

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
  Layer.provide(servicesLayer),
  Layer.provide(lalphConfigLayer)
)

const eventSourcesLayer = process.env["MOCK_GITHUB"] === "1"
  ? Layer.succeed(PullRequestTracker, { eventStream: Stream.never })
  : PullRequestTrackerLive.pipe(
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

const projectStoreLayer = ProjectStoreLive

const planOverviewUploaderMapLayer = PlanOverviewUploaderMap.Default.pipe(
  Layer.provide(octokitLayer)
)

const planOverviewUploaderLayer = Layer.unwrapEffect(
  Effect.gen(function*() {
    const config = yield* LalphConfig
    return PlanOverviewUploaderMap.get(config.specUploader)
  })
).pipe(
  Layer.provide(planOverviewUploaderMapLayer),
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
  autoMergeLayer,
  commentTimerLayer,
  branchParserLayer,
  planSessionLayer,
  octokitLayer,
  projectStoreLayer,
  planOverviewUploaderLayer
)

// ── Event loop ───────────────────────────────────────────────────

/**
 * The main event loop that boots the chat state machine, bridges streams,
 * and dispatches external events (PR/task notifications).
 * @since 1.0.0
 * @category event-loop
 */
export const runEventLoop = Effect.gen(function*() {
  const pullRequestTracker = yield* PullRequestTracker
  const autoMerge = yield* AutoMerge
  const notifier = yield* MessengerAdapter
  const github = yield* GitHubClient
  const timer = yield* CommentTimer
  const taskTracker = yield* TaskTracker
  const branchParser = yield* BranchParser
  const lalphConfig = yield* LalphConfig
  const planSession = yield* PlanSession

  // Boot the chat state machine
  const actor = yield* Machine.boot(chatMachine)

  // ── External event dispatch (unchanged) ──────────────────────

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
            "[Automatic] This PR has merge conflicts that need to be resolved."
          )
          const issueIdOption = branchParser.resolveIssueId(e.pr)
          if (Option.isSome(issueIdOption)) {
            const issueId = issueIdOption.value
            yield* taskTracker.moveToTodo(issueId).pipe(
              Effect.tapError((err) =>
                Effect.logError(`Failed to move to todo: ${err.message}`)
              ),
              Effect.orElseSucceed(() =>
                undefined
              )
            )
            yield* taskTracker.setPriorityUrgent(issueId).pipe(
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
            yield* taskTracker.moveToTodo(issueId).pipe(
              Effect.tapError((err) => Effect.logError(`Failed to move to todo: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            yield* taskTracker.setPriorityUrgent(issueId).pipe(
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

  // ── Stream bridges ───────────────────────────────────────────

  // Telegram messages → UserMessage requests
  const incomingMessageStream = notifier.incomingMessages.pipe(
    Stream.mapEffect((msg) =>
      actor.send(new UserMessage({ text: msg.text })).pipe(
        Effect.catchAll((err) => Effect.logError(`Incoming message error: ${String(err)}`))
      )
    )
  )

  // PlanSession events → Machine requests
  const planEventStream = planSession.events.pipe(
    Stream.mapEffect((event) =>
      Match.value(event).pipe(
        Match.tag("PlanTextOutput", (e) => actor.send(new PlanTextOutput({ text: e.text }))),
        Match.tag("PlanQuestion", (e) => actor.send(new PlanQuestionReceived({ questions: e.questions }))),
        Match.tag("PlanSpecCreated", () => actor.send(new PlanSpecCreatedReq())),
        Match.tag("PlanSpecUpdated", () => actor.send(new PlanSpecUpdatedReq())),
        Match.tag("PlanAnalysisReady", () => actor.send(new PlanAnalysisReadyReq())),
        Match.tag("PlanAwaitingInput", () => actor.send(new PlanAwaitingInputReq())),
        Match.tag("PlanTaskCreationStarted", () => {
          const source = lalphConfig.issueSource === "linear" ? "Linear" : "GitHub"
          return actor.send(new PlanTextOutput({ text: `Task creation in ${source} started.` }))
        }),
        Match.tag("PlanCompleted", () => actor.send(new PlanCompletedReq())),
        Match.tag("PlanFailed", (e) => actor.send(new PlanFailedReq({ message: e.message }))),
        Match.exhaustive
      ).pipe(
        Effect.catchAll((err) => Effect.logError(`Plan event relay error: ${String(err)}`))
      )
    )
  )

  // ── External event streams ───────────────────────────────────

  const mergedStream = Stream.merge(
    Stream.merge(
      pullRequestTracker.eventStream.pipe(Stream.map((e): AppEvent => e)),
      autoMerge.eventStream.pipe(Stream.map((e): AppEvent => e))
    ),
    taskTracker.eventStream.pipe(Stream.map((e): AppEvent => e))
  )

  yield* notifier.sendMessage({
    text: "🚀 Notification service started.",
    replyKeyboard: IDLE_KEYBOARD
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
    Effect.catchAll((err) => Effect.logError(`Event loop error: ${String(err)}`)),
    Effect.forkDaemon
  )

  // Block until interrupted — keeps the Machine scope alive for daemon fibers
  yield* Effect.never
}).pipe(Effect.scoped)
