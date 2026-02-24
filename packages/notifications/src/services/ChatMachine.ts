/**
 * Chat state machine using @effect/experimental/Machine
 * @since 1.0.0
 */
import * as Machine from "@effect/experimental/Machine"
import { Data, Effect, Option, Schema } from "effect"
import { getAnalysisPrompt } from "../lib/AnalysisPrompts.js"
import type { SpecFile } from "../lib/SpecHtmlGenerator.js"
import { markdownToTelegramHtml, splitMessage } from "../lib/TelegramFormatter.js"
import { MessengerAdapter, type OutgoingMessage } from "./MessengerAdapter/MessengerAdapter.js"
import { PlanOverviewUploader } from "./PlanOverviewUploader.js"
import { PlanSession } from "./PlanSession.js"
import { ProjectStore } from "./ProjectStore.js"

// ── Button labels ────────────────────────────────────────────────

export const PLAN_BUTTON_LABEL = "Plan"
export const DONE_BUTTON_LABEL = "Done"
export const FEATURE_BUTTON_LABEL = "Feature"
export const BUG_BUTTON_LABEL = "Bug"
export const REFACTOR_BUTTON_LABEL = "Refactor"
export const OTHER_BUTTON_LABEL = "Other"
export const APPROVE_BUTTON_LABEL = "Approve"
export const BUFFER_BUTTON_LABEL = "Buffer"
export const INTERRUPT_BUTTON_LABEL = "Interrupt"
export const DISCARD_BUTTON_LABEL = "Discard"
export const ABORT_BUTTON_LABEL = "Abort"
export const NEW_PROJECT_BUTTON_LABEL = "New project"

const MY_ANSWER_BUTTON_LABEL = "Custom answer"
const BACK_BUTTON_LABEL = "Back"

const PLAN_TYPE_LABELS = [
  FEATURE_BUTTON_LABEL,
  BUG_BUTTON_LABEL,
  REFACTOR_BUTTON_LABEL,
  OTHER_BUTTON_LABEL
]

// ── Keyboards ────────────────────────────────────────────────────

export const IDLE_KEYBOARD = [{ label: PLAN_BUTTON_LABEL }, { label: NEW_PROJECT_BUTTON_LABEL }]
const COLLECTING_KEYBOARD = [{ label: DONE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]
const SESSION_KEYBOARD = [{ label: ABORT_BUTTON_LABEL }]
const SPEC_READY_KEYBOARD = [{ label: APPROVE_BUTTON_LABEL }, { label: ABORT_BUTTON_LABEL }]

// ── State types ──────────────────────────────────────────────────

type CreatingProjectStep = "Name" | "Concurrency" | "TargetBranch" | "GitFlow" | "ReviewAgent"

interface CreatingProjectData {
  readonly name?: string
  readonly concurrency?: number
  readonly targetBranch?: string | null
  readonly gitFlow?: "pr" | "commit"
  readonly reviewAgent?: boolean
}

export class ReadyFlags extends Data.Class<{
  readonly spec: boolean
  readonly analysis: boolean
  readonly idle: boolean
}> {}

/* eslint-disable @typescript-eslint/no-empty-object-type */
export type ChatState = Data.TaggedEnum<{
  Idle: {}
  SelectingProject: {}
  /* eslint-enable @typescript-eslint/no-empty-object-type */
  SelectingPlanType: { readonly projectId: string }
  CollectingPlan: {
    readonly projectId: string
    readonly planType: string
    readonly buffer: ReadonlyArray<string>
  }
  SessionRunning: {
    readonly projectId: string
    readonly planType: string
    readonly pendingAnswerCount: number
    readonly pendingOptionLabels: ReadonlySet<string>
    readonly answersBuffer: ReadonlyArray<string>
    readonly awaitingFreeTextAnswer: boolean
    readonly lastQuestionMessage: Option.Option<OutgoingMessage>
    readonly readyFlags: ReadyFlags
    readonly analysisFollowUpSent: boolean
  }
  AwaitingFollowUpDecision: {
    readonly projectId: string
    readonly planType: string
    readonly message: string
    readonly readyFlags: ReadyFlags
    readonly analysisFollowUpSent: boolean
  }
  SpecReady: {
    readonly projectId: string
    readonly planType: string
    readonly readyFlags: ReadyFlags
    readonly analysisFollowUpSent: boolean
  }
  CreatingProject: {
    readonly step: CreatingProjectStep
    readonly data: CreatingProjectData
    readonly continueWithPlan: boolean
  }
}>

export const ChatState = Data.taggedEnum<ChatState>()

const initialSessionRunning = (projectId: string, planType: string): ChatState =>
  ChatState.SessionRunning({
    projectId,
    planType,
    pendingAnswerCount: 0,
    pendingOptionLabels: new Set(),
    answersBuffer: [],
    awaitingFreeTextAnswer: false,
    lastQuestionMessage: Option.none(),
    readyFlags: new ReadyFlags({ spec: false, analysis: false, idle: false }),
    analysisFollowUpSent: false
  })

// ── Request types ────────────────────────────────────────────────

export class UserMessage extends Schema.TaggedRequest<UserMessage>()("UserMessage", {
  failure: Schema.Never,
  success: Schema.Void,
  payload: { text: Schema.String }
}) {}

export class PlanTextOutput extends Schema.TaggedRequest<PlanTextOutput>()("PlanTextOutput", {
  failure: Schema.Never,
  success: Schema.Void,
  payload: { text: Schema.String }
}) {}

export class PlanQuestionReceived extends Schema.TaggedRequest<PlanQuestionReceived>()(
  "PlanQuestionReceived",
  {
    failure: Schema.Never,
    success: Schema.Void,
    payload: {
      questions: Schema.Array(Schema.Struct({
        question: Schema.String,
        header: Schema.optional(Schema.String),
        options: Schema.optional(Schema.Array(Schema.Struct({ label: Schema.String })))
      }))
    }
  }
) {}

export class PlanSpecCreatedReq extends Schema.TaggedRequest<PlanSpecCreatedReq>()(
  "PlanSpecCreatedReq",
  { failure: Schema.Never, success: Schema.Void, payload: {} }
) {}

export class PlanSpecUpdatedReq extends Schema.TaggedRequest<PlanSpecUpdatedReq>()(
  "PlanSpecUpdatedReq",
  { failure: Schema.Never, success: Schema.Void, payload: {} }
) {}

export class PlanAnalysisReadyReq extends Schema.TaggedRequest<PlanAnalysisReadyReq>()(
  "PlanAnalysisReadyReq",
  { failure: Schema.Never, success: Schema.Void, payload: {} }
) {}

export class PlanAwaitingInputReq extends Schema.TaggedRequest<PlanAwaitingInputReq>()(
  "PlanAwaitingInputReq",
  { failure: Schema.Never, success: Schema.Void, payload: {} }
) {}

export class PlanCompletedReq extends Schema.TaggedRequest<PlanCompletedReq>()(
  "PlanCompletedReq",
  { failure: Schema.Never, success: Schema.Void, payload: {} }
) {}

export class PlanFailedReq extends Schema.TaggedRequest<PlanFailedReq>()(
  "PlanFailedReq",
  { failure: Schema.Never, success: Schema.Void, payload: { message: Schema.String } }
) {}

// ── Machine definition ───────────────────────────────────────────

type HandlerResult = readonly [void, ChatState]
const reply = (state: ChatState): HandlerResult => [undefined, state]

export const chatMachine = Machine.make(
  Effect.gen(function*() {
    // Capture services at init (closures — handlers have R = never)
    const notifier = yield* MessengerAdapter
    const planSession = yield* PlanSession
    const projectStore = yield* ProjectStore
    const planOverviewUploader = yield* PlanOverviewUploader

    // ── Helpers ────────────────────────────────────────────────

    const readSpecFiles = (planType: string) =>
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

    const sendSpecFilesRaw = (files: ReadonlyArray<SpecFile>) =>
      Effect.forEach(files, (file) => {
        const formatted = file.mermaid
          ? markdownToTelegramHtml(`\`\`\`mermaid\n${file.content}\n\`\`\``)
          : markdownToTelegramHtml(file.content)
        const text = `<b>${file.name}</b>\n${formatted}`
        return Effect.forEach(splitMessage(text), (chunk) => notifier.sendMessage(chunk))
      })

    const sendSpecFiles = (planType: string) =>
      Effect.gen(function*() {
        const files = yield* readSpecFiles(planType)
        yield* planOverviewUploader.upload({ files, description: `Spec: ${planType}` }).pipe(
          Effect.tap((result) => notifier.sendMessage(`<a href="${result.url}">View spec</a>`)),
          Effect.catchTag("PlanOverviewUploaderError", (err) =>
            Effect.gen(function*() {
              yield* Effect.logError(`Spec upload failed, sending raw: ${err.message}`)
              yield* sendSpecFilesRaw(files)
            }))
        )
      })

    const rejectSession = planSession.reject.pipe(
      Effect.tapError((err) => Effect.logError(`Plan abort error: ${err.message}`)),
      Effect.orElseSucceed(() => undefined)
    )

    const abortToIdle = (hasSession: boolean) =>
      Effect.gen(function*() {
        if (hasSession) {
          yield* rejectSession
        }
        yield* Effect.log("Plan aborted")
        yield* notifier.sendMessage({ text: "Plan aborted.", replyKeyboard: IDLE_KEYBOARD })
      })

    const submitAnswers = (answers: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const combined = answers.join("\n")
        yield* Effect.log("Flushing batched answers to plan session")
        yield* planSession.answer(combined).pipe(
          Effect.tapError((err) => Effect.logError(`Plan answer error: ${err.message}`)),
          Effect.orElseSucceed(() => undefined)
        )
      })

    const showFollowUpChoice = (
      text: string,
      projectId: string,
      planType: string,
      readyFlags: ReadyFlags,
      analysisFollowUpSent: boolean
    ) =>
      Effect.gen(function*() {
        yield* Effect.log("Holding follow-up message, showing buffer/interrupt buttons")
        yield* notifier.sendMessage({
          text: "Send as follow-up or interrupt Claude?",
          options: [
            { label: BUFFER_BUTTON_LABEL },
            { label: INTERRUPT_BUTTON_LABEL },
            { label: DISCARD_BUTTON_LABEL }
          ]
        })
        return ChatState.AwaitingFollowUpDecision({
          projectId,
          planType,
          message: text,
          readyFlags,
          analysisFollowUpSent
        })
      })

    const checkAllReady = (
      projectId: string,
      planType: string,
      flags: ReadyFlags,
      analysisFollowUpSent: boolean
    ): Effect.Effect<ChatState, never, never> =>
      Effect.gen(function*() {
        if (!flags.spec || !flags.analysis || !flags.idle) {
          return ChatState.SessionRunning({
            projectId,
            planType,
            pendingAnswerCount: 0,
            pendingOptionLabels: new Set(),
            answersBuffer: [],
            awaitingFreeTextAnswer: false,
            lastQuestionMessage: Option.none(),
            readyFlags: flags,
            analysisFollowUpSent
          })
        }
        yield* sendSpecFiles(planType).pipe(
          Effect.catchAll((err) => Effect.logError(`Failed to send spec files: ${String(err)}`))
        )
        yield* notifier.sendMessage({
          text: "Spec ready. Reply with questions or approve to proceed.",
          replyKeyboard: SPEC_READY_KEYBOARD
        }).pipe(Effect.orElseSucceed(() => undefined))
        return ChatState.SpecReady({ projectId, planType, readyFlags: flags, analysisFollowUpSent })
      })

    const maybeAnalysisFollowUp = (
      planType: string,
      alreadySent: boolean
    ) =>
      alreadySent
        ? Effect.succeed(true)
        : planSession.sendFollowUp(getAnalysisPrompt(planType)).pipe(
          Effect.tapError((err) => Effect.logError(`Analysis follow-up error: ${err.message}`)),
          Effect.orElseSucceed(() => undefined),
          Effect.as(true)
        )

    /**
     * Extract projectId, planType, readyFlags, and analysisFollowUpSent from any
     * "active session" state (SessionRunning, AwaitingFollowUpDecision, SpecReady).
     */
    const extractActiveState = (state: ChatState) => {
      switch (state._tag) {
        case "SessionRunning":
          return Option.some({
            projectId: state.projectId,
            planType: state.planType,
            readyFlags: state.readyFlags,
            analysisFollowUpSent: state.analysisFollowUpSent
          })
        case "AwaitingFollowUpDecision":
          return Option.some({
            projectId: state.projectId,
            planType: state.planType,
            readyFlags: state.readyFlags,
            analysisFollowUpSent: state.analysisFollowUpSent
          })
        case "SpecReady":
          return Option.some({
            projectId: state.projectId,
            planType: state.planType,
            readyFlags: state.readyFlags,
            analysisFollowUpSent: state.analysisFollowUpSent
          })
        default:
          return Option.none()
      }
    }

    // ── Procedure handlers ─────────────────────────────────────

    return Machine.procedures.make<ChatState>(ChatState.Idle()).pipe(
      // ── UserMessage ────────────────────────────────────────
      Machine.procedures.add<UserMessage>()("UserMessage", (ctx) =>
        Effect.gen(function*() {
          const { state } = ctx
          const text = ctx.request.text
          yield* Effect.log(`Incoming message: ${text}`)

          switch (state._tag) {
            case "Idle": {
              if (text === PLAN_BUTTON_LABEL) {
                const projects = yield* projectStore.listProjects.pipe(
                  Effect.orElseSucceed((): ReadonlyArray<{ id: string }> => [])
                )
                if (projects.length === 0) {
                  yield* notifier.sendMessage("No projects. Create one first.")
                  return reply(state)
                }
                if (projects.length === 1) {
                  yield* Effect.log("Single project auto-selected").pipe(
                    Effect.annotateLogs("projectId", projects[0]!.id)
                  )
                  yield* notifier.sendMessage({
                    text: "What type of change?",
                    options: [...PLAN_TYPE_LABELS.map((label) => ({ label })), { label: ABORT_BUTTON_LABEL }]
                  })
                  return reply(ChatState.SelectingPlanType({ projectId: projects[0]!.id }))
                }
                yield* notifier.sendMessage({
                  text: "Select a project:",
                  options: [
                    ...projects.map((p) => ({ label: p.id })),
                    { label: NEW_PROJECT_BUTTON_LABEL },
                    { label: ABORT_BUTTON_LABEL }
                  ]
                })
                return reply(ChatState.SelectingProject())
              }
              if (text === NEW_PROJECT_BUTTON_LABEL) {
                yield* notifier.sendMessage("Enter project name:")
                return reply(ChatState.CreatingProject({
                  step: "Name",
                  data: {},
                  continueWithPlan: false
                }))
              }
              return reply(state)
            }

            case "SelectingProject": {
              if (text === ABORT_BUTTON_LABEL) {
                yield* notifier.sendMessage({ text: "Plan aborted.", replyKeyboard: IDLE_KEYBOARD })
                return reply(ChatState.Idle())
              }
              if (text === NEW_PROJECT_BUTTON_LABEL) {
                yield* notifier.sendMessage("Enter project name:")
                return reply(ChatState.CreatingProject({
                  step: "Name",
                  data: {},
                  continueWithPlan: true
                }))
              }
              yield* Effect.log("Project selected").pipe(
                Effect.annotateLogs("projectId", text)
              )
              yield* notifier.sendMessage({
                text: "What type of change?",
                options: [...PLAN_TYPE_LABELS.map((label) => ({ label })), { label: ABORT_BUTTON_LABEL }]
              })
              return reply(ChatState.SelectingPlanType({ projectId: text }))
            }

            case "SelectingPlanType": {
              if (text === ABORT_BUTTON_LABEL) {
                yield* notifier.sendMessage({ text: "Plan aborted.", replyKeyboard: IDLE_KEYBOARD })
                return reply(ChatState.Idle())
              }
              if (PLAN_TYPE_LABELS.includes(text)) {
                yield* Effect.log("Plan type selected, collection started").pipe(
                  Effect.annotateLogs("planType", text)
                )
                yield* notifier.sendMessage({
                  text: "Describe what you'd like to plan. Tap <b>Done</b> when ready.",
                  replyKeyboard: COLLECTING_KEYBOARD
                })
                return reply(ChatState.CollectingPlan({
                  projectId: state.projectId,
                  planType: text,
                  buffer: []
                }))
              }
              return reply(state)
            }

            case "CollectingPlan": {
              if (text === ABORT_BUTTON_LABEL) {
                yield* abortToIdle(false)
                return reply(ChatState.Idle())
              }
              if (text === DONE_BUTTON_LABEL) {
                const joinedText = state.buffer.join("\n")
                if (joinedText.trim().length === 0) {
                  yield* Effect.log("Plan collection done with empty buffer")
                  yield* notifier.sendMessage("No plan description provided.")
                  return reply(state)
                }
                yield* Effect.log("Plan collection done, starting session").pipe(
                  Effect.annotateLogs("planText", joinedText)
                )
                const totalProjects = yield* projectStore.listProjects.pipe(
                  Effect.map((ps) => ps.length),
                  Effect.orElseSucceed(() => 1)
                )
                yield* planSession.start(joinedText, totalProjects > 1 ? state.projectId : undefined).pipe(
                  Effect.tapError((err) => notifier.sendMessage(`Plan error: ${err.message}`)),
                  Effect.orElseSucceed(() => undefined)
                )
                yield* notifier.sendMessage({
                  text: "Planning started...",
                  replyKeyboard: SESSION_KEYBOARD
                })
                return reply(initialSessionRunning(state.projectId, state.planType))
              }
              yield* Effect.log("Buffering plan message").pipe(
                Effect.annotateLogs("bufferedText", text)
              )
              yield* notifier.sendMessage("✓ Added. Tap <b>Done</b> when ready.")
              return reply(ChatState.CollectingPlan({
                projectId: state.projectId,
                planType: state.planType,
                buffer: [...state.buffer, text]
              }))
            }

            case "SessionRunning": {
              if (text === ABORT_BUTTON_LABEL) {
                yield* abortToIdle(true)
                return reply(ChatState.Idle())
              }
              if (state.pendingAnswerCount > 0 && state.pendingOptionLabels.has(text)) {
                if (text === MY_ANSWER_BUTTON_LABEL) {
                  yield* notifier.sendMessage({
                    text: "Type your answer:",
                    options: [{ label: BACK_BUTTON_LABEL }]
                  })
                  return reply(ChatState.SessionRunning({ ...state, awaitingFreeTextAnswer: true }))
                }
                if (text === BACK_BUTTON_LABEL) {
                  if (Option.isSome(state.lastQuestionMessage)) {
                    yield* notifier.sendMessage(state.lastQuestionMessage.value)
                  }
                  return reply(ChatState.SessionRunning({ ...state, awaitingFreeTextAnswer: false }))
                }
                const newBuffer = [...state.answersBuffer, text]
                const newPending = state.pendingAnswerCount - 1
                if (newPending <= 0) {
                  yield* Effect.log("Buffering answer")
                  yield* submitAnswers(newBuffer)
                  return reply(ChatState.SessionRunning({
                    ...state,
                    awaitingFreeTextAnswer: false,
                    answersBuffer: [],
                    pendingAnswerCount: 0,
                    pendingOptionLabels: new Set(),
                    readyFlags: new ReadyFlags({ ...state.readyFlags, idle: false })
                  }))
                }
                yield* Effect.log("Buffering answer")
                return reply(ChatState.SessionRunning({
                  ...state,
                  awaitingFreeTextAnswer: false,
                  answersBuffer: newBuffer,
                  pendingAnswerCount: newPending
                }))
              }
              if (state.awaitingFreeTextAnswer) {
                const newBuffer = [...state.answersBuffer, text]
                const newPending = state.pendingAnswerCount - 1
                if (newPending <= 0) {
                  yield* Effect.log("Buffering free-text answer")
                  yield* submitAnswers(newBuffer)
                  return reply(ChatState.SessionRunning({
                    ...state,
                    awaitingFreeTextAnswer: false,
                    answersBuffer: [],
                    pendingAnswerCount: 0,
                    pendingOptionLabels: new Set(),
                    readyFlags: new ReadyFlags({ ...state.readyFlags, idle: false })
                  }))
                }
                yield* Effect.log("Buffering free-text answer")
                return reply(ChatState.SessionRunning({
                  ...state,
                  awaitingFreeTextAnswer: false,
                  answersBuffer: newBuffer,
                  pendingAnswerCount: newPending
                }))
              }
              const idle = yield* planSession.isIdle
              if (idle) {
                yield* planSession.sendFollowUp(text).pipe(
                  Effect.tap(() => notifier.sendMessage("Follow-up sent.")),
                  Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
                  Effect.orElseSucceed(() => undefined)
                )
                return reply(ChatState.SessionRunning({
                  ...state,
                  readyFlags: new ReadyFlags({ ...state.readyFlags, idle: false })
                }))
              }
              const newState = yield* showFollowUpChoice(
                text,
                state.projectId,
                state.planType,
                state.readyFlags,
                state.analysisFollowUpSent
              )
              return reply(newState)
            }

            case "AwaitingFollowUpDecision": {
              if (text === BUFFER_BUTTON_LABEL) {
                yield* Effect.log("Buffering follow-up message")
                yield* planSession.sendFollowUp(state.message).pipe(
                  Effect.tap(() => notifier.sendMessage("Message buffered — Claude will process it shortly.")),
                  Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
                  Effect.orElseSucceed(() => undefined)
                )
                return reply(ChatState.SessionRunning({
                  projectId: state.projectId,
                  planType: state.planType,
                  pendingAnswerCount: 0,
                  pendingOptionLabels: new Set(),
                  answersBuffer: [],
                  awaitingFreeTextAnswer: false,
                  lastQuestionMessage: Option.none(),
                  readyFlags: new ReadyFlags({ ...state.readyFlags, idle: false }),
                  analysisFollowUpSent: state.analysisFollowUpSent
                }))
              }
              if (text === INTERRUPT_BUTTON_LABEL) {
                yield* Effect.log("Interrupting Claude with follow-up message")
                yield* planSession.interrupt(state.message).pipe(
                  Effect.tap(() => notifier.sendMessage("Claude interrupted — processing your message now.")),
                  Effect.tapError((err) => Effect.logError(`Plan interrupt error: ${err.message}`)),
                  Effect.orElseSucceed(() => undefined)
                )
                return reply(ChatState.SessionRunning({
                  projectId: state.projectId,
                  planType: state.planType,
                  pendingAnswerCount: 0,
                  pendingOptionLabels: new Set(),
                  answersBuffer: [],
                  awaitingFreeTextAnswer: false,
                  lastQuestionMessage: Option.none(),
                  readyFlags: new ReadyFlags({ ...state.readyFlags, idle: false }),
                  analysisFollowUpSent: state.analysisFollowUpSent
                }))
              }
              if (text === DISCARD_BUTTON_LABEL) {
                yield* Effect.log("Follow-up message discarded")
                yield* notifier.sendMessage("Message discarded.")
                return reply(ChatState.SessionRunning({
                  projectId: state.projectId,
                  planType: state.planType,
                  pendingAnswerCount: 0,
                  pendingOptionLabels: new Set(),
                  answersBuffer: [],
                  awaitingFreeTextAnswer: false,
                  lastQuestionMessage: Option.none(),
                  readyFlags: state.readyFlags,
                  analysisFollowUpSent: state.analysisFollowUpSent
                }))
              }
              if (text === ABORT_BUTTON_LABEL) {
                yield* abortToIdle(true)
                return reply(ChatState.Idle())
              }
              return reply(state)
            }

            case "SpecReady": {
              if (text === APPROVE_BUTTON_LABEL) {
                yield* Effect.log("User approved task creation")
                yield* planSession.approve.pipe(
                  Effect.tapError((err) => Effect.logError(`Plan approve error: ${err.message}`)),
                  Effect.orElseSucceed(() => undefined)
                )
                yield* notifier.sendMessage({ text: "Spec approved.", replyKeyboard: IDLE_KEYBOARD })
                return reply(ChatState.Idle())
              }
              if (text === ABORT_BUTTON_LABEL) {
                yield* abortToIdle(true)
                return reply(ChatState.Idle())
              }
              const idleSpec = yield* planSession.isIdle
              if (idleSpec) {
                yield* planSession.sendFollowUp(text).pipe(
                  Effect.tap(() => notifier.sendMessage("Follow-up sent.")),
                  Effect.tapError((err) => Effect.logError(`Plan follow-up error: ${err.message}`)),
                  Effect.orElseSucceed(() => undefined)
                )
                return reply(ChatState.SessionRunning({
                  projectId: state.projectId,
                  planType: state.planType,
                  pendingAnswerCount: 0,
                  pendingOptionLabels: new Set(),
                  answersBuffer: [],
                  awaitingFreeTextAnswer: false,
                  lastQuestionMessage: Option.none(),
                  readyFlags: new ReadyFlags({ ...state.readyFlags, idle: false }),
                  analysisFollowUpSent: state.analysisFollowUpSent
                }))
              }
              const followUpState = yield* showFollowUpChoice(
                text,
                state.projectId,
                state.planType,
                state.readyFlags,
                state.analysisFollowUpSent
              )
              return reply(followUpState)
            }

            case "CreatingProject": {
              if (text === ABORT_BUTTON_LABEL) {
                yield* notifier.sendMessage({ text: "Project creation cancelled.", replyKeyboard: IDLE_KEYBOARD })
                return reply(ChatState.Idle())
              }
              switch (state.step) {
                case "Name": {
                  yield* notifier.sendMessage({
                    text: "Concurrency (tasks in parallel):",
                    options: [
                      { label: "1" },
                      { label: "2" },
                      { label: "3" },
                      { label: "4" },
                      { label: ABORT_BUTTON_LABEL }
                    ]
                  })
                  return reply(ChatState.CreatingProject({
                    ...state,
                    step: "Concurrency",
                    data: { ...state.data, name: text }
                  }))
                }
                case "Concurrency": {
                  const n = Number(text)
                  if (isNaN(n) || n < 1) return reply(state)
                  yield* notifier.sendMessage({
                    text: "Target branch (type branch name or skip):",
                    options: [{ label: "Skip" }, { label: ABORT_BUTTON_LABEL }]
                  })
                  return reply(ChatState.CreatingProject({
                    ...state,
                    step: "TargetBranch",
                    data: { ...state.data, concurrency: n }
                  }))
                }
                case "TargetBranch": {
                  const targetBranch = text === "Skip" ? null : text
                  yield* notifier.sendMessage({
                    text: "Git flow:",
                    options: [
                      { label: "PR" },
                      { label: "Commit" },
                      { label: ABORT_BUTTON_LABEL }
                    ]
                  })
                  return reply(ChatState.CreatingProject({
                    ...state,
                    step: "GitFlow",
                    data: { ...state.data, targetBranch }
                  }))
                }
                case "GitFlow": {
                  const gitFlow = text === "Commit" ? "commit" as const : "pr" as const
                  yield* notifier.sendMessage({
                    text: "Enable review agent?",
                    options: [
                      { label: "Yes" },
                      { label: "No" },
                      { label: ABORT_BUTTON_LABEL }
                    ]
                  })
                  return reply(ChatState.CreatingProject({
                    ...state,
                    step: "ReviewAgent",
                    data: { ...state.data, gitFlow }
                  }))
                }
                case "ReviewAgent": {
                  const reviewAgent = text === "Yes"
                  const data = state.data
                  yield* projectStore.createProject({
                    id: data.name!,
                    targetBranch: data.targetBranch != null ? Option.some(data.targetBranch) : Option.none(),
                    concurrency: data.concurrency!,
                    gitFlow: data.gitFlow!,
                    reviewAgent
                  }).pipe(
                    Effect.tapError((err) => notifier.sendMessage(`Failed to create project: ${err.message}`)),
                    Effect.orElseSucceed(() => undefined)
                  )
                  yield* notifier.sendMessage(`Project <b>${data.name!}</b> created.`)
                  if (state.continueWithPlan) {
                    yield* notifier.sendMessage({
                      text: "What type of change?",
                      options: [...PLAN_TYPE_LABELS.map((label) => ({ label })), { label: ABORT_BUTTON_LABEL }]
                    })
                    return reply(ChatState.SelectingPlanType({ projectId: data.name! }))
                  }
                  yield* notifier.sendMessage({ text: "Ready.", replyKeyboard: IDLE_KEYBOARD })
                  return reply(ChatState.Idle())
                }
              }
            }
          }
        }).pipe(
          Effect.annotateLogs("service", "PlanInput"),
          Effect.tapError((err) => Effect.logError(`Incoming message error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanTextOutput ─────────────────────────────────────
      Machine.procedures.add<PlanTextOutput>()("PlanTextOutput", (ctx) =>
        Effect.gen(function*() {
          yield* Effect.forEach(splitMessage(markdownToTelegramHtml(ctx.request.text)), (chunk) =>
            notifier.sendMessage(chunk))
          return reply(ctx.state)
        }).pipe(
          Effect.tapError((err) =>
            Effect.logError(`Plan event relay error: ${String(err)}`)
          ),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanQuestionReceived ───────────────────────────────
      Machine.procedures.add<PlanQuestionReceived>()("PlanQuestionReceived", (ctx) =>
        Effect.gen(function*() {
          const { request, state } = ctx
          if (state._tag !== "SessionRunning") {
            return reply(state)
          }
          const labels = request.questions.flatMap((q) => q.options?.map((o) => o.label) ?? [])
          const newPendingLabels = new Set([...labels, MY_ANSWER_BUTTON_LABEL, BACK_BUTTON_LABEL])
          let lastQ: Option.Option<OutgoingMessage> = Option.none()
          yield* Effect.forEach(request.questions, (q) => {
            const formatted = markdownToTelegramHtml(q.question)
            const header = q.header != null ? `<b>${markdownToTelegramHtml(q.header)}</b>\n` : ""
            const baseOptions = q.options?.map((o) => ({ label: o.label })) ?? []
            const msg: OutgoingMessage = {
              text: `${header}${formatted}`,
              options: [...baseOptions, { label: MY_ANSWER_BUTTON_LABEL }]
            }
            lastQ = Option.some(msg)
            return notifier.sendMessage(msg)
          })
          return reply(ChatState.SessionRunning({
            ...state,
            pendingAnswerCount: request.questions.length,
            pendingOptionLabels: newPendingLabels,
            answersBuffer: [],
            awaitingFreeTextAnswer: false,
            lastQuestionMessage: lastQ
          }))
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanSpecCreatedReq ─────────────────────────────────
      Machine.procedures.add<PlanSpecCreatedReq>()("PlanSpecCreatedReq", (ctx) =>
        Effect.gen(function*() {
          const active = extractActiveState(ctx.state)
          if (Option.isNone(active)) return reply(ctx.state)
          const { analysisFollowUpSent, planType, projectId, readyFlags } = active.value
          const sent = yield* maybeAnalysisFollowUp(planType, analysisFollowUpSent)
          const newFlags = new ReadyFlags({ ...readyFlags, spec: true })
          const newState = yield* checkAllReady(projectId, planType, newFlags, sent)
          return reply(newState)
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanSpecUpdatedReq ─────────────────────────────────
      Machine.procedures.add<PlanSpecUpdatedReq>()("PlanSpecUpdatedReq", (ctx) =>
        Effect.gen(function*() {
          const active = extractActiveState(ctx.state)
          if (Option.isNone(active)) return reply(ctx.state)
          const { analysisFollowUpSent, planType, projectId, readyFlags } = active.value
          const sent = yield* maybeAnalysisFollowUp(planType, analysisFollowUpSent)
          const newFlags = new ReadyFlags({ ...readyFlags, spec: true })
          const newState = yield* checkAllReady(projectId, planType, newFlags, sent)
          return reply(newState)
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanAnalysisReadyReq ───────────────────────────────
      Machine.procedures.add<PlanAnalysisReadyReq>()("PlanAnalysisReadyReq", (ctx) =>
        Effect.gen(function*() {
          const active = extractActiveState(ctx.state)
          if (Option.isNone(active)) return reply(ctx.state)
          const { analysisFollowUpSent, planType, projectId, readyFlags } = active.value
          const newFlags = new ReadyFlags({ ...readyFlags, analysis: true })
          const newState = yield* checkAllReady(projectId, planType, newFlags, analysisFollowUpSent)
          return reply(newState)
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanAwaitingInputReq ───────────────────────────────
      Machine.procedures.add<PlanAwaitingInputReq>()("PlanAwaitingInputReq", (ctx) =>
        Effect.gen(function*() {
          const active = extractActiveState(ctx.state)
          if (Option.isNone(active)) return reply(ctx.state)
          const { analysisFollowUpSent, planType, projectId, readyFlags } = active.value
          const newFlags = new ReadyFlags({ ...readyFlags, idle: true })
          const newState = yield* checkAllReady(projectId, planType, newFlags, analysisFollowUpSent)
          return reply(newState)
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanCompletedReq ───────────────────────────────────
      Machine.procedures.add<PlanCompletedReq>()("PlanCompletedReq", (ctx) =>
        Effect.gen(function*() {
          yield* notifier.sendMessage({ text: "Plan completed.", replyKeyboard: IDLE_KEYBOARD })
          return reply(ChatState.Idle())
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        )),
      // ── PlanFailedReq ──────────────────────────────────────
      Machine.procedures.add<PlanFailedReq>()("PlanFailedReq", (ctx) =>
        Effect.gen(function*() {
          yield* notifier.sendMessage({
            text: `Plan failed: ${ctx.request.message}`,
            replyKeyboard: IDLE_KEYBOARD
          })
          return reply(ChatState.Idle())
        }).pipe(
          Effect.tapError((err) => Effect.logError(`Plan event relay error: ${String(err)}`)),
          Effect.orElseSucceed(() => reply(ctx.state))
        ))
    )
  })
)
