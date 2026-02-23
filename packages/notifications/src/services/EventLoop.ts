/**
 * Event loop and layer construction for the notification service
 * @since 1.0.0
 */
import { Console, Data, Effect, Layer, Match, Option, Ref, Stream } from "effect"
import type { AppEvent } from "../Events.js"
import { getAnalysisPrompt } from "../lib/AnalysisPrompts.js"
import { BranchParser, BranchParserLive } from "../lib/BranchParser.js"
import { generateSpecHtml } from "../lib/SpecHtmlGenerator.js"
import { markdownToTelegramHtml, splitMessage } from "../lib/TelegramFormatter.js"
import { GitHubRepo } from "../schemas/GitHubSchemas.js"
import { AutoMerge, AutoMergeLive } from "./AutoMerge.js"
import { CommentTimer, CommentTimerLive } from "./CommentTimer.js"
import { GitHubClient, GitHubClientLive } from "./GitHubClient.js"
import { LalphConfig, LalphConfigLive } from "./LalphConfig.js"
import { MessengerAdapter, type OutgoingMessage } from "./MessengerAdapter/MessengerAdapter.js"
import { TelegramAdapterLive } from "./MessengerAdapter/TelegramAdapter.js"
import { OctokitClient, OctokitClientLive } from "./OctokitClient.js"
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
  planSessionLayer,
  octokitLayer
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
const MY_ANSWER_BUTTON_LABEL = "Custom answer"
const BACK_BUTTON_LABEL = "Back"

type ChatState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "SelectingPlanType" }
  | { readonly _tag: "CollectingPlan"; readonly planType: string; readonly buffer: ReadonlyArray<string> }
  | { readonly _tag: "SessionRunning"; readonly planType: string }
  | { readonly _tag: "AwaitingFollowUpDecision"; readonly planType: string; readonly message: string }
  | { readonly _tag: "SpecReady"; readonly planType: string }

const IDLE_KEYBOARD = [{ label: PLAN_BUTTON_LABEL }]
const COLLECTING_KEYBOARD = [{ label: DONE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
const SESSION_KEYBOARD = [{ label: ABORT_BUTTON_LABEL }]
const SPEC_READY_KEYBOARD = [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]

export const runEventLoop = Effect.gen(function*() {
  const pullRequestTracker = yield* PullRequestTracker
  const autoMerge = yield* AutoMerge
  const notifier = yield* MessengerAdapter
  const github = yield* GitHubClient
  const timer = yield* CommentTimer
  const taskTracker = yield* TaskTracker
  const branchParser = yield* BranchParser
  const planSession = yield* PlanSession
  const octokitClient = yield* OctokitClient

  const state = yield* Ref.make<ChatState>({ _tag: "Idle" })
  const pendingAnswerCount = yield* Ref.make(0)
  const pendingOptionLabels = yield* Ref.make<ReadonlySet<string>>(new Set())
  const analysisFollowUpSent = yield* Ref.make(false)
  const awaitingFreeTextAnswer = yield* Ref.make(false)
  const lastQuestionMessage = yield* Ref.make<Option.Option<OutgoingMessage>>(Option.none())

  class ReadyFlags extends Data.Class<{ spec: boolean; analysis: boolean; idle: boolean }> {}
  const readyFlags = yield* Ref.make(new ReadyFlags({ spec: false, analysis: false, idle: false }))

  const readSpecFiles = (planType: string) =>
    (
      planType === "Feature"
        ? planSession.readFeatureAnalysis.pipe(
          Effect.map((files) => [
            { name: "analysis.md", content: files.analysis, mermaid: false },
            { name: "services.mmd", content: files.services, mermaid: true },
            { name: "test.md", content: files.test, mermaid: false }
          ])
        )
        : planType === "Bug"
        ? planSession.readBugAnalysis.pipe(
          Effect.map((files) => [{ name: "analysis.md", content: files.analysis, mermaid: false }])
        )
        : planType === "Refactor"
        ? planSession.readRefactorAnalysis.pipe(
          Effect.map((files) => [{ name: "analysis.md", content: files.analysis, mermaid: false }])
        )
        : planSession.readDefaultAnalysis.pipe(
          Effect.map((files) => [{ name: "analysis.md", content: files.analysis, mermaid: false }])
        )
    ).pipe(Effect.option)

  const sendSpecFilesRaw = (files: ReadonlyArray<{ name: string; content: string; mermaid: boolean }>) =>
    Effect.forEach(files, (file) => {
      const formatted = file.mermaid
        ? markdownToTelegramHtml(`\`\`\`mermaid\n${file.content}\n\`\`\``)
        : markdownToTelegramHtml(file.content)
      const text = `<b>${file.name}</b>\n${formatted}`
      return Effect.forEach(splitMessage(text), (chunk) => notifier.sendMessage(chunk))
    })

  const sendSpecFiles = (planType: string) =>
    Effect.gen(function*() {
      const readResult = yield* readSpecFiles(planType)

      if (Option.isSome(readResult)) {
        const files = readResult.value
        const html = generateSpecHtml(files)
        const gistResult = yield* octokitClient.createGist({
          description: `Spec: ${planType}`,
          files: { "spec.html": { content: html } },
          isPublic: false
        }).pipe(Effect.option)

        if (Option.isSome(gistResult)) {
          const rawUrl = gistResult.value.files["spec.html"]?.rawUrl ?? gistResult.value.htmlUrl
          const viewUrl = `https://htmlpreview.github.io/?${rawUrl}`
          yield* notifier.sendMessage(`<a href="${viewUrl}">View spec</a>`)
        } else {
          yield* sendSpecFilesRaw(files)
        }
      }
    })

  const showApproveIfReady = Effect.gen(function*() {
    const flags = yield* Ref.get(readyFlags)
    if (!flags.spec || !flags.analysis || !flags.idle) return
    const current = yield* Ref.get(state)
    const planType = current._tag === "SessionRunning" || current._tag === "AwaitingFollowUpDecision" ||
        current._tag === "SpecReady"
      ? current.planType
      : "Other"
    yield* Ref.set(state, { _tag: "SpecReady", planType })
    yield* sendSpecFiles(planType)
    yield* notifier.sendMessage({
      text: "Spec ready. Reply with questions or approve to proceed.",
      replyKeyboard: SPEC_READY_KEYBOARD
    })
  })

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

  const rejectSession = planSession.reject.pipe(
    Effect.tapError((err) => Effect.logError(`Plan abort error: ${err.message}`)),
    Effect.orElseSucceed(() => undefined)
  )

  const abortToIdle = (hasSession: boolean) =>
    Effect.gen(function*() {
      if (hasSession) {
        yield* rejectSession
      }
      yield* Ref.set(state, { _tag: "Idle" })
      yield* Ref.set(pendingAnswerCount, 0)
      yield* Ref.set(pendingOptionLabels, new Set())
      yield* Ref.set(analysisFollowUpSent, false)
      yield* Ref.set(readyFlags, new ReadyFlags({ spec: false, analysis: false, idle: false }))
      yield* Ref.set(awaitingFreeTextAnswer, false)
      yield* Effect.log("Plan aborted")
      yield* notifier.sendMessage({ text: "Plan aborted.", replyKeyboard: IDLE_KEYBOARD })
    })

  const showFollowUpChoice = (text: string, planType: string) =>
    Effect.gen(function*() {
      yield* Ref.set(state, { _tag: "AwaitingFollowUpDecision", planType, message: text })
      yield* Effect.log("Holding follow-up message, showing buffer/interrupt buttons")
      yield* notifier.sendMessage({
        text: "Send as follow-up or interrupt Claude?",
        options: [
          { label: BUFFER_BUTTON_LABEL },
          { label: INTERRUPT_BUTTON_LABEL },
          { label: OMIT_BUTTON_LABEL },
          { label: ABORT_BUTTON_LABEL }
        ]
      })
    })

  const handleIncomingMessage = (msg: { text: string }) =>
    Effect.gen(function*() {
      yield* Effect.log(`Incoming message: ${msg.text}`)
      const current = yield* Ref.get(state)

      switch (current._tag) {
        case "Idle": {
          if (msg.text === PLAN_BUTTON_LABEL) {
            yield* Ref.set(state, { _tag: "SelectingPlanType" })
            yield* Effect.log("Plan type selection shown")
            yield* notifier.sendMessage({
              text: "What type of change?",
              options: [...PLAN_TYPE_LABELS.map((label) => ({ label })), { label: ABORT_BUTTON_LABEL }]
            })
          }
          return
        }
        case "SelectingPlanType": {
          if (msg.text === ABORT_BUTTON_LABEL) {
            yield* Ref.set(state, { _tag: "Idle" })
            yield* notifier.sendMessage({ text: "Plan aborted.", replyKeyboard: IDLE_KEYBOARD })
            return
          }
          if (PLAN_TYPE_LABELS.includes(msg.text)) {
            yield* Ref.set(state, { _tag: "CollectingPlan", planType: msg.text, buffer: [] })
            yield* Effect.log("Plan type selected, collection started").pipe(
              Effect.annotateLogs("planType", msg.text)
            )
            yield* notifier.sendMessage({
              text: "Describe what you'd like to plan. Tap <b>Done</b> when ready.",
              replyKeyboard: COLLECTING_KEYBOARD
            })
          }
          return
        }
        case "CollectingPlan": {
          if (msg.text === ABORT_BUTTON_LABEL) {
            yield* abortToIdle(false)
            return
          }
          if (msg.text === DONE_BUTTON_LABEL) {
            const joinedText = current.buffer.join("\n")
            if (joinedText.trim().length === 0) {
              yield* Effect.log("Plan collection done with empty buffer")
              yield* notifier.sendMessage("No plan description provided.")
              return
            }
            yield* Ref.set(state, { _tag: "SessionRunning", planType: current.planType })
            yield* Ref.set(analysisFollowUpSent, false)
            yield* Ref.set(readyFlags, new ReadyFlags({ spec: false, analysis: false, idle: false }))
            yield* Effect.log("Plan collection done, starting session").pipe(
              Effect.annotateLogs("planText", joinedText)
            )
            yield* planSession.start(joinedText).pipe(
              Effect.tapError((err) => notifier.sendMessage(`Plan error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            yield* notifier.sendMessage({
              text: "Planning started...",
              replyKeyboard: SESSION_KEYBOARD
            })
            return
          }
          yield* Ref.set(state, {
            _tag: "CollectingPlan",
            planType: current.planType,
            buffer: [...current.buffer, msg.text]
          })
          yield* Effect.log("Buffering plan message").pipe(
            Effect.annotateLogs("bufferedText", msg.text)
          )
          yield* notifier.sendMessage("✓ Added. Tap <b>Done</b> when ready.")
          return
        }
        case "SessionRunning": {
          if (msg.text === ABORT_BUTTON_LABEL) {
            yield* abortToIdle(true)
            return
          }
          const pending = yield* Ref.get(pendingAnswerCount)
          const options = yield* Ref.get(pendingOptionLabels)
          const isAwaitingFreeText = yield* Ref.get(awaitingFreeTextAnswer)
          if (pending > 0 && options.has(msg.text)) {
            if (msg.text === MY_ANSWER_BUTTON_LABEL) {
              yield* Ref.set(awaitingFreeTextAnswer, true)
              yield* notifier.sendMessage({
                text: "Type your answer:",
                options: [{ label: BACK_BUTTON_LABEL }]
              })
              return
            }
            if (msg.text === BACK_BUTTON_LABEL) {
              yield* Ref.set(awaitingFreeTextAnswer, false)
              const lastQ = yield* Ref.get(lastQuestionMessage)
              if (Option.isSome(lastQ)) {
                yield* notifier.sendMessage(lastQ.value)
              }
              return
            }
            yield* Ref.set(awaitingFreeTextAnswer, false)
            yield* Effect.log("Forwarding answer to plan session")
            yield* Ref.update(pendingAnswerCount, (n) => n - 1)
            yield* planSession.answer(msg.text).pipe(
              Effect.tapError((err) => Effect.logError(`Plan answer error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            const newPending = yield* Ref.get(pendingAnswerCount)
            if (newPending <= 0) {
              yield* Ref.set(pendingOptionLabels, new Set())
            }
            return
          }
          if (isAwaitingFreeText) {
            yield* Ref.set(awaitingFreeTextAnswer, false)
            yield* Effect.log("Forwarding free-text answer to plan session")
            yield* Ref.update(pendingAnswerCount, (n) => n - 1)
            yield* planSession.answer(msg.text).pipe(
              Effect.tapError((err) => Effect.logError(`Plan answer error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            const newPending = yield* Ref.get(pendingAnswerCount)
            if (newPending <= 0) {
              yield* Ref.set(pendingOptionLabels, new Set())
            }
            return
          }
          const idle = yield* planSession.isIdle
          if (idle) {
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            yield* planSession.sendFollowUp(msg.text).pipe(
              Effect.tap(() => notifier.sendMessage("Follow-up sent.")),
              Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
          } else {
            yield* showFollowUpChoice(msg.text, current.planType)
          }
          return
        }
        case "AwaitingFollowUpDecision": {
          if (msg.text === BUFFER_BUTTON_LABEL) {
            yield* Effect.log("Buffering follow-up message")
            yield* Ref.set(state, { _tag: "SessionRunning", planType: current.planType })
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            yield* planSession.sendFollowUp(current.message).pipe(
              Effect.tap(() => notifier.sendMessage("Message buffered — Claude will process it shortly.")),
              Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            return
          }
          if (msg.text === INTERRUPT_BUTTON_LABEL) {
            yield* Effect.log("Interrupting Claude with follow-up message")
            yield* Ref.set(state, { _tag: "SessionRunning", planType: current.planType })
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            yield* planSession.interrupt(current.message).pipe(
              Effect.tap(() => notifier.sendMessage("Claude interrupted — processing your message now.")),
              Effect.tapError((err) => Effect.logError(`Plan interrupt error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            return
          }
          if (msg.text === OMIT_BUTTON_LABEL) {
            yield* Ref.set(state, { _tag: "SessionRunning", planType: current.planType })
            yield* Effect.log("Follow-up message discarded")
            yield* notifier.sendMessage("Message discarded.")
            return
          }
          if (msg.text === ABORT_BUTTON_LABEL) {
            yield* abortToIdle(true)
            return
          }
          return
        }
        case "SpecReady": {
          if (msg.text === APPROVE_BUTTON_LABEL) {
            yield* Effect.log("User approved task creation")
            yield* Ref.set(state, { _tag: "SessionRunning", planType: current.planType })
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            yield* planSession.approve.pipe(
              Effect.tapError((err) => Effect.logError(`Plan approve error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
            return
          }
          if (msg.text === ABORT_BUTTON_LABEL) {
            yield* abortToIdle(true)
            return
          }
          const idleSpec = yield* planSession.isIdle
          if (idleSpec) {
            yield* Ref.set(state, { _tag: "SessionRunning", planType: current.planType })
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: false }))
            yield* planSession.sendFollowUp(msg.text).pipe(
              Effect.tap(() => notifier.sendMessage("Follow-up sent.")),
              Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
              Effect.orElseSucceed(() => undefined)
            )
          } else {
            yield* showFollowUpChoice(msg.text, current.planType)
          }
          return
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
            const labels = e.questions.flatMap((q) => q.options?.map((o) => o.label) ?? [])
            yield* Ref.update(pendingOptionLabels, (s) =>
              new Set([...s, ...labels, MY_ANSWER_BUTTON_LABEL, BACK_BUTTON_LABEL]))
            yield* Effect.forEach(e.questions, (q) => {
              const formatted = markdownToTelegramHtml(q.question)
              const header = q.header != null ? `<b>${markdownToTelegramHtml(q.header)}</b>\n` : ""
              const baseOptions = q.options?.map((o) => ({ label: o.label })) ?? []
              const msg: OutgoingMessage = {
                text: `${header}${formatted}`,
                options: [...baseOptions, { label: MY_ANSWER_BUTTON_LABEL }]
              }
              return Ref.set(lastQuestionMessage, Option.some(msg)).pipe(
                Effect.andThen(notifier.sendMessage(msg))
              )
            })
          })),
        Match.tag("PlanSpecCreated", (e) =>
          Effect.gen(function*() {
            const current = yield* Ref.get(state)
            const planType = current._tag === "SessionRunning" || current._tag === "AwaitingFollowUpDecision" ||
                current._tag === "SpecReady"
              ? current.planType
              : "Other"
            yield* notifier.sendMessage(`Spec file created: <code>${e.filePath}</code>`)
            const alreadySent = yield* Ref.getAndSet(analysisFollowUpSent, true)
            if (!alreadySent) {
              yield* planSession.sendFollowUp(getAnalysisPrompt(planType)).pipe(
                Effect.tapError((err) => Effect.logError(`Analysis follow-up error: ${err.message}`)),
                Effect.orElseSucceed(() => undefined)
              )
            }
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, spec: true }))
            yield* showApproveIfReady
          })),
        Match.tag("PlanSpecUpdated", (e) =>
          Effect.gen(function*() {
            const current = yield* Ref.get(state)
            const planType = current._tag === "SessionRunning" || current._tag === "AwaitingFollowUpDecision" ||
                current._tag === "SpecReady"
              ? current.planType
              : "Other"
            yield* notifier.sendMessage(`Spec file updated: <code>${e.filePath}</code>`)
            const alreadySent = yield* Ref.getAndSet(analysisFollowUpSent, true)
            if (!alreadySent) {
              yield* planSession.sendFollowUp(getAnalysisPrompt(planType)).pipe(
                Effect.tapError((err) => Effect.logError(`Analysis follow-up error: ${err.message}`)),
                Effect.orElseSucceed(() => undefined)
              )
            }
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, spec: true }))
            yield* showApproveIfReady
          })),
        Match.tag("PlanAnalysisReady", () =>
          Effect.gen(function*() {
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, analysis: true }))
            yield* showApproveIfReady
          })),
        Match.tag("PlanAwaitingInput", () =>
          Effect.gen(function*() {
            yield* Ref.update(readyFlags, (f) => new ReadyFlags({ ...f, idle: true }))
            yield* showApproveIfReady
          })),
        Match.tag("PlanCompleted", () =>
          Effect.gen(function*() {
            yield* Ref.set(state, { _tag: "Idle" })
            yield* Ref.set(analysisFollowUpSent, false)
            yield* Ref.set(readyFlags, new ReadyFlags({ spec: false, analysis: false, idle: false }))
            yield* notifier.sendMessage({ text: "Plan completed.", replyKeyboard: IDLE_KEYBOARD })
          })),
        Match.tag("PlanFailed", (e) =>
          Effect.gen(function*() {
            yield* Ref.set(state, { _tag: "Idle" })
            yield* Ref.set(analysisFollowUpSent, false)
            yield* Ref.set(readyFlags, new ReadyFlags({ spec: false, analysis: false, idle: false }))
            yield* notifier.sendMessage({ text: `Plan failed: ${e.message}`, replyKeyboard: IDLE_KEYBOARD })
          })),
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
