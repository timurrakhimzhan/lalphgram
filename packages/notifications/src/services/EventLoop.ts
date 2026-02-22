/**
 * Event loop and layer construction for the notification service
 * @since 1.0.0
 */
import { Console, Effect, Layer, Match, Option, Ref, Stream } from "effect"
import type { AppEvent } from "../Events.js"
import { BranchParser, BranchParserLive } from "../lib/BranchParser.js"
import { markdownToTelegramHtml, splitMessage } from "../lib/TelegramFormatter.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { AutoMerge, AutoMergeLive } from "./AutoMerge.js"
import { CommentTimer, CommentTimerLive } from "./CommentTimer.js"
import { GitHubClient, GitHubClientLive } from "./GitHubClient.js"
import { LalphConfig, LalphConfigLive } from "./LalphConfig.js"
import { MessengerAdapter } from "./MessengerAdapter/MessengerAdapter.js"
import { TelegramAdapterLive } from "./MessengerAdapter/TelegramAdapter.js"
import { OctokitClientLive } from "./OctokitClient.js"
import { PlanSession, PlanSessionLive } from "./PlanSession.js"
import { PullRequestTracker, PullRequestTrackerLive } from "./PullRequestTracker.js"
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
  Layer.provide(servicesLayer),
  Layer.provide(lalphConfigLayer)
)

const eventSourcesLayer = PullRequestTrackerLive.pipe(
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
  autoMergeLayer,
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
export const FEATURE_BUTTON_LABEL = "Feature"
export const BUG_BUTTON_LABEL = "Bug"
export const REFACTOR_BUTTON_LABEL = "Refactor"
export const OTHER_BUTTON_LABEL = "Other"

const PLAN_TYPE_LABELS = [
  FEATURE_BUTTON_LABEL,
  BUG_BUTTON_LABEL,
  REFACTOR_BUTTON_LABEL,
  OTHER_BUTTON_LABEL
]
export const APPROVE_BUTTON_LABEL = "Approve"
export const BUFFER_BUTTON_LABEL = "Buffer"
export const INTERRUPT_BUTTON_LABEL = "Interrupt"
export const OMIT_BUTTON_LABEL = "Omit"
export const ABORT_BUTTON_LABEL = "Abort"

export const runEventLoop = Effect.gen(function*() {
  const pullRequestTracker = yield* PullRequestTracker
  const autoMerge = yield* AutoMerge
  const notifier = yield* MessengerAdapter
  const github = yield* GitHubClient
  const timer = yield* CommentTimer
  const taskTracker = yield* TaskTracker
  const branchParser = yield* BranchParser
  const planSession = yield* PlanSession

  const collectingPlan = yield* Ref.make(false)
  const planBuffer = yield* Ref.make<ReadonlyArray<string>>([])
  const planType = yield* Ref.make<Option.Option<string>>(Option.none())
  const pendingAnswerCount = yield* Ref.make(0)
  const pendingFollowUp = yield* Ref.make<Option.Option<string>>(Option.none())

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

  const handleIncomingMessage = (msg: { text: string }) =>
    Effect.gen(function*() {
      yield* Effect.log(`Incoming message: ${msg.text}`)
      if (msg.text === PLAN_BUTTON_LABEL) {
        yield* Effect.log("Plan type selection shown")
        yield* notifier.sendMessage({
          text: "What type of change?",
          options: [...PLAN_TYPE_LABELS.map((label) => ({ label })), { label: ABORT_BUTTON_LABEL }]
        })
        return
      }
      if (PLAN_TYPE_LABELS.includes(msg.text)) {
        yield* Effect.log("Plan type selected, collection started").pipe(
          Effect.annotateLogs("planType", msg.text)
        )
        yield* Ref.set(planType, Option.some(msg.text))
        yield* Ref.set(collectingPlan, true)
        yield* Ref.set(planBuffer, [])
        yield* notifier.sendMessage({
          text: "Describe what you'd like to plan. Tap <b>Done</b> when ready.",
          replyKeyboard: [{ label: DONE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
        })
        return
      }
      if (msg.text === ABORT_BUTTON_LABEL) {
        yield* Ref.set(collectingPlan, false)
        yield* Ref.set(planBuffer, [])
        yield* Ref.set(planType, Option.none())
        yield* Ref.set(pendingFollowUp, Option.none())
        yield* Ref.set(pendingAnswerCount, 0)
        const active = yield* planSession.isActive
        if (active) {
          yield* planSession.reject.pipe(
            Effect.tapError((err) => Effect.logError(`Plan abort error: ${err.message}`)),
            Effect.orElseSucceed(() => undefined)
          )
        }
        yield* Effect.log("Plan session aborted")
        yield* notifier.sendMessage("Plan aborted.")
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
        yield* notifier.sendMessage({
          text: "Planning started...",
          replyKeyboard: [{ label: ABORT_BUTTON_LABEL }]
        })
        return
      }
      if (isCollecting) {
        yield* Effect.log("Buffering plan message").pipe(
          Effect.annotateLogs("bufferedText", msg.text)
        )
        yield* Ref.update(planBuffer, (buf) => [...buf, msg.text])
        yield* notifier.sendMessage("✓ Added. Tap <b>Done</b> when ready.")
        return
      }
      const active = yield* planSession.isActive
      if (active) {
        if (msg.text === APPROVE_BUTTON_LABEL) {
          yield* Effect.log("User approved task creation")
          yield* planSession.approve.pipe(
            Effect.tapError((err) => Effect.logError(`Plan approve error: ${err.message}`)),
            Effect.orElseSucceed(() => undefined)
          )
          return
        }
        if (msg.text === BUFFER_BUTTON_LABEL) {
          const stored = yield* Ref.getAndSet(pendingFollowUp, Option.none())
          if (Option.isSome(stored)) {
            yield* Effect.log("Buffering follow-up message")
            yield* planSession.sendFollowUp(stored.value).pipe(
              Effect.tap(() => notifier.sendMessage("Message buffered — Claude will process it shortly.")),
              Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
          }
          return
        }
        if (msg.text === INTERRUPT_BUTTON_LABEL) {
          const stored = yield* Ref.getAndSet(pendingFollowUp, Option.none())
          if (Option.isSome(stored)) {
            yield* Effect.log("Interrupting Claude with follow-up message")
            yield* planSession.interrupt(stored.value).pipe(
              Effect.tap(() => notifier.sendMessage("Claude interrupted — processing your message now.")),
              Effect.tapError((err) => Effect.logError(`Plan interrupt error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
          }
          return
        }
        if (msg.text === OMIT_BUTTON_LABEL) {
          yield* Ref.set(pendingFollowUp, Option.none())
          yield* Effect.log("Follow-up message discarded")
          yield* notifier.sendMessage("Message discarded.")
          return
        }
        const pending = yield* Ref.get(pendingAnswerCount)
        if (pending > 0) {
          yield* Effect.log("Forwarding answer to plan session")
          yield* Ref.update(pendingAnswerCount, (n) => n - 1)
          yield* planSession.answer(msg.text).pipe(
            Effect.tapError((err) => Effect.logError(`Plan answer error: ${err.message}`)),
            Effect.orElseSucceed(() => undefined)
          )
        } else {
          yield* Effect.log("Holding follow-up message, showing buffer/interrupt buttons")
          yield* Ref.set(pendingFollowUp, Option.some(msg.text))
          yield* notifier.sendMessage({
            text: "Send as follow-up or interrupt Claude?",
            options: [
              { label: BUFFER_BUTTON_LABEL },
              { label: INTERRUPT_BUTTON_LABEL },
              { label: OMIT_BUTTON_LABEL },
              { label: ABORT_BUTTON_LABEL }
            ]
          })
        }
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
        Match.tag("PlanTextOutput", (e) =>
          Effect.forEach(splitMessage(markdownToTelegramHtml(e.text)), (chunk) => notifier.sendMessage(chunk))),
        Match.tag("PlanQuestion", (e) =>
          Effect.gen(function*() {
            yield* Ref.update(pendingAnswerCount, (n) =>
              n + e.questions.length)
            yield* Effect.forEach(e.questions, (q) => {
              const formatted = markdownToTelegramHtml(q.question)
              const header = q.header != null ? `<b>${markdownToTelegramHtml(q.header)}</b>\n` : ""
              return notifier.sendMessage({
                text: `${header}${formatted}`,
                options: q.options?.map((o) => ({ label: o.label }))
              })
            })
          })),
        Match.tag("PlanSpecReady", () =>
          notifier.sendMessage({
            text: "Spec ready. Reply with questions or approve to proceed.",
            replyKeyboard: [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
          })),
        Match.tag("PlanCompleted", () => notifier.sendMessage("Plan completed.")),
        Match.tag("PlanFailed", (e) => notifier.sendMessage(`Plan failed: ${e.message}`)),
        Match.exhaustive
      ).pipe(
        Effect.catchAll((err) => Effect.logError(`Plan event relay error: ${String(err)}`))
      )
    )
  )

  const mergedStream = Stream.merge(
    Stream.merge(
      pullRequestTracker.eventStream.pipe(Stream.map((e): AppEvent => e)),
      autoMerge.eventStream.pipe(Stream.map((e): AppEvent => e))
    ),
    taskTracker.eventStream.pipe(Stream.map((e): AppEvent => e))
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
