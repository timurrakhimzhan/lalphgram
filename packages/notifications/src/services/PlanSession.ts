/**
 * Plan session manager — spawns `lalph plan` subprocess and bridges I/O
 * @since 1.0.0
 */
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Exit, identity, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import type { ContentBlock } from "../lib/StreamJsonParser.js"
import { AskUserQuestionInput, StreamJsonMessage } from "../lib/StreamJsonParser.js"
import { AppContext } from "./AppContext.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class PlanSessionError extends Data.TaggedError("PlanSessionError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanTextOutput extends Data.TaggedClass("PlanTextOutput")<{
  readonly text: string
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanCompleted extends Data.TaggedClass("PlanCompleted")<{
  readonly exitCode: number
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanFailed extends Data.TaggedClass("PlanFailed")<{
  readonly message: string
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanQuestion extends Data.TaggedClass("PlanQuestion")<{
  readonly questions: ReadonlyArray<{
    readonly question: string
    readonly header?: string | undefined
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string | undefined }> | undefined
    readonly multiSelect?: boolean | undefined
  }>
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanSpecCreated extends Data.TaggedClass("PlanSpecCreated")<{
  readonly filePath: string
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanSpecUpdated extends Data.TaggedClass("PlanSpecUpdated")<{
  readonly filePath: string
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export class PlanAnalysisReady extends Data.TaggedClass("PlanAnalysisReady")<{
  readonly filePath: string
}> {}

/**
 * @since 1.0.0
 * @category events
 */
export type PlanEvent =
  | PlanTextOutput
  | PlanQuestion
  | PlanCompleted
  | PlanFailed
  | PlanSpecCreated
  | PlanSpecUpdated
  | PlanAnalysisReady

interface ActiveSession {
  readonly process: CommandExecutor.Process
  readonly scope: Scope.CloseableScope
  readonly stdinQueue: Queue.Queue<Uint8Array>
}

/**
 * @since 1.0.0
 * @category services
 */
export interface PlanSessionService {
  readonly start: (planText: string) => Effect.Effect<void, PlanSessionError>
  readonly answer: (text: string) => Effect.Effect<void, PlanSessionError>
  readonly sendFollowUp: (text: string) => Effect.Effect<void, PlanSessionError>
  readonly interrupt: (text: string) => Effect.Effect<void, PlanSessionError>
  readonly approve: Effect.Effect<void, PlanSessionError>
  readonly reject: Effect.Effect<void, PlanSessionError>
  readonly isActive: Effect.Effect<boolean>
  readonly events: Stream.Stream<PlanEvent, PlanSessionError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class PlanSession extends Context.Tag("PlanSession")<
  PlanSession,
  PlanSessionService
>() {}

/**
 * Builds the command to run for a plan session.
 * @since 1.0.0
 * @category context
 */
export class PlanCommandBuilder extends Context.Tag("PlanCommandBuilder")<
  PlanCommandBuilder,
  (tempFile: string) => Command.Command
>() {}

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")

const WriteToolInput = Schema.Struct({ file_path: Schema.String })
const EditToolInput = Schema.Struct({ file_path: Schema.String })
const NotebookEditToolInput = Schema.Struct({ notebook_path: Schema.String })

const decodeWriteInput = Schema.decodeUnknown(WriteToolInput)
const decodeEditInput = Schema.decodeUnknown(EditToolInput)
const decodeNotebookInput = Schema.decodeUnknown(NotebookEditToolInput)

const isSpecFile = (path: string): boolean =>
  ((path.includes(".specs/") || path.includes(".specs\\")) && !path.endsWith("analysis.md")) ||
  path.endsWith(".lalph/plan.json")

const isAnalysisFile = (path: string): boolean =>
  path.endsWith(".specs/analysis.md") || path.endsWith(".specs\\analysis.md")

const decodeAskInput = Schema.decodeUnknown(AskUserQuestionInput)
const decodeJsonMessage = Schema.decodeUnknown(Schema.parseJson(StreamJsonMessage))

/**
 * @since 1.0.0
 * @category layers
 */
export const PlanSessionLive = Layer.scoped(
  PlanSession,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const appContext = yield* AppContext
    const executor = yield* CommandExecutor.CommandExecutor
    const buildCommand = yield* PlanCommandBuilder
    const sessionRef = yield* Ref.make<Option.Option<ActiveSession>>(Option.none())
    const eventQueue = yield* Queue.unbounded<PlanEvent>()
    const seenFilePaths = yield* Ref.make<ReadonlySet<string>>(new Set())

    const closeActiveSession = Effect.gen(function*() {
      const current = yield* Ref.get(sessionRef)
      if (Option.isSome(current)) {
        yield* Scope.close(current.value.scope, Exit.void)
        yield* Ref.set(sessionRef, Option.none())
      }
    })

    yield* Effect.addFinalizer(() => closeActiveSession)

    const start = (planText: string) =>
      Effect.gen(function*() {
        const current = yield* Ref.get(sessionRef)
        if (Option.isSome(current)) {
          return yield* new PlanSessionError({
            message: "A plan session is already active",
            cause: null
          })
        }

        yield* Ref.set(seenFilePaths, new Set())

        const tempDir = pathService.join(appContext.configDir, "tmp")
        yield* fs.makeDirectory(tempDir, { recursive: true }).pipe(
          Effect.mapError((err) =>
            new PlanSessionError({ message: `Failed to create temp dir: ${String(err)}`, cause: err })
          )
        )

        const tempFile = pathService.join(tempDir, `plan-${Date.now()}.md`)
        yield* fs.writeFileString(tempFile, planText).pipe(
          Effect.mapError((err) =>
            new PlanSessionError({ message: `Failed to write plan file: ${String(err)}`, cause: err })
          )
        )

        const cmd = buildCommand(tempFile)

        const processScope = yield* Scope.make()

        const process = yield* Command.start(cmd).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Scope.extend(processScope),
          Effect.mapError((err) =>
            new PlanSessionError({ message: `Failed to start lalph plan: ${String(err)}`, cause: err })
          )
        )

        const stdinQueue = yield* Queue.unbounded<Uint8Array>()
        yield* Ref.set(sessionRef, Option.some({ process, scope: processScope, stdinQueue }))
        yield* Effect.log("Plan session process spawned").pipe(
          Effect.annotateLogs({ tempFile })
        )

        yield* Stream.fromQueue(stdinQueue).pipe(
          Stream.run(process.stdin),
          Effect.catchAll((err) => Effect.logError(`stdin write error: ${String(err)}`)),
          Effect.forkDaemon
        )

        const decoder = new TextDecoder()
        const pendingTextRef = yield* Ref.make<Option.Option<{ messageId: string; text: string }>>(
          Option.none()
        )

        const flushPendingText = Effect.gen(function*() {
          const pending = yield* Ref.get(pendingTextRef)
          if (Option.isSome(pending)) {
            yield* Effect.log("Flushing buffered text block").pipe(
              Effect.annotateLogs({ textLength: String(pending.value.text.length) })
            )
            yield* Queue.offer(eventQueue, new PlanTextOutput({ text: pending.value.text }))
            yield* Ref.set(pendingTextRef, Option.none())
          }
        })

        const detectFileEvent = (block: typeof ContentBlock.Type) =>
          Effect.gen(function*() {
            const filePathResult = yield* Effect.gen(function*() {
              switch (block.name) {
                case "Write":
                  return (yield* decodeWriteInput(block.input)).file_path
                case "Edit":
                  return (yield* decodeEditInput(block.input)).file_path
                case "NotebookEdit":
                  return (yield* decodeNotebookInput(block.input)).notebook_path
                default:
                  return yield* Effect.fail("not a file-writing tool")
              }
            }).pipe(Effect.option)
            if (Option.isSome(filePathResult)) {
              const fp = filePathResult.value
              if (isAnalysisFile(fp)) {
                yield* Effect.log("Analysis file detected").pipe(
                  Effect.annotateLogs({ filePath: fp })
                )
                yield* Queue.offer(eventQueue, new PlanAnalysisReady({ filePath: fp }))
              } else if (isSpecFile(fp)) {
                const seen = yield* Ref.get(seenFilePaths)
                if (seen.has(fp)) {
                  yield* Effect.log("Spec file updated").pipe(
                    Effect.annotateLogs({ filePath: fp })
                  )
                  yield* Queue.offer(eventQueue, new PlanSpecUpdated({ filePath: fp }))
                } else {
                  yield* Ref.update(seenFilePaths, (s) => new Set([...s, fp]))
                  yield* Effect.log("Spec file created").pipe(
                    Effect.annotateLogs({ filePath: fp })
                  )
                  yield* Queue.offer(eventQueue, new PlanSpecCreated({ filePath: fp }))
                }
              }
            }
          })

        const processContentBlock = (block: typeof ContentBlock.Type, messageId: string, hasAskUser: boolean) =>
          Effect.gen(function*() {
            if (block.type === "text" && block.text != null && hasAskUser) {
              yield* Effect.log("Suppressing text block (ask_user in same line)")
            } else if (block.type === "text" && block.text != null) {
              yield* Effect.log("Buffering text block").pipe(
                Effect.annotateLogs({ textLength: String(block.text.length), messageId })
              )
              yield* Ref.set(pendingTextRef, Option.some({ messageId, text: block.text }))
            } else if (block.type === "tool_use" && block.name === "mcp__ask-user__ask_user") {
              yield* Effect.log("ask_user MCP tool detected, discarding buffered text")
              yield* Ref.set(pendingTextRef, Option.none())
              const askParsed = yield* decodeAskInput(block.input).pipe(
                Effect.orElseSucceed(() => ({ questions: undefined }))
              )
              if (askParsed.questions != null && askParsed.questions.length > 0) {
                yield* Queue.offer(eventQueue, new PlanQuestion({ questions: askParsed.questions }))
              }
            } else if (block.type === "tool_use" && block.name != null) {
              yield* Effect.log("Tool invoked").pipe(
                Effect.annotateLogs({ tool: block.name })
              )
              yield* detectFileEvent(block)
            }
          })

        const processAssistantMessage = (msg: StreamJsonMessage) =>
          Effect.gen(function*() {
            const content = msg.message?.content
            if (content == null) return
            const messageId = msg.message?.id ?? ""
            const pending = yield* Ref.get(pendingTextRef)
            if (Option.isSome(pending) && pending.value.messageId !== messageId) {
              yield* flushPendingText
            }
            const hasAskUser = content.some(
              (b) => b.type === "tool_use" && b.name === "mcp__ask-user__ask_user"
            )
            for (const block of content) {
              yield* processContentBlock(block, messageId, hasAskUser)
            }
          })

        const routeMessage = (msg: StreamJsonMessage) =>
          Effect.gen(function*() {
            yield* Effect.log("Parsed stream-json message").pipe(
              Effect.annotateLogs({
                messageType: msg.type,
                ...(msg.subtype != null ? { subtype: msg.subtype } : {})
              })
            )
            if (msg.type === "shim_ready") {
              yield* Effect.log("shim_ready received, auto-sending shim_start")
              const encoder = new TextEncoder()
              yield* Queue.offer(stdinQueue, encoder.encode(JSON.stringify({ type: "shim_start" }) + "\n"))
              return
            }
            if (msg.type === "result") {
              yield* flushPendingText
              yield* Effect.log("Planner result received")
              return
            }
            if (msg.type !== "assistant" || msg.message?.content == null) {
              yield* flushPendingText
              return
            }
            yield* processAssistantMessage(msg)
          })

        yield* process.stdout.pipe(
          Stream.map((chunk) => decoder.decode(chunk)),
          Stream.tap((chunk) =>
            Effect.log("stdout chunk received").pipe(
              Effect.annotateLogs({ chunkLength: String(chunk.length), preview: chunk.slice(0, 200) })
            )
          ),
          Stream.splitLines,
          Stream.filter((line) => line.trim().length > 0),
          Stream.mapEffect((line) =>
            decodeJsonMessage(line).pipe(
              Effect.tapError((err) =>
                Effect.logWarning("Non-JSON stdout line, skipping").pipe(
                  Effect.annotateLogs({ line: line.slice(0, 300), error: err.message.slice(0, 100) })
                )
              ),
              Effect.option
            )
          ),
          Stream.filterMap(identity),
          Stream.mapEffect(routeMessage),
          Stream.runDrain,
          Effect.tap(() => flushPendingText),
          Effect.tap(() => Effect.log("stdout stream completed")),
          Effect.tapError((err) =>
            Queue.offer(eventQueue, new PlanFailed({ message: `stdout stream error: ${String(err)}` }))
          ),
          Effect.catchAll((err) => Effect.logError(`stdout stream error: ${String(err)}`)),
          Effect.forkDaemon
        )

        yield* process.stderr.pipe(
          Stream.map((chunk) => decoder.decode(chunk)),
          Stream.tap((chunk) =>
            Effect.log("stderr chunk received").pipe(
              Effect.annotateLogs({ chunkLength: String(chunk.length), preview: chunk.slice(0, 200) })
            )
          ),
          Stream.map(stripAnsi),
          Stream.flatMap((text) => {
            const lines = text.split("\n").filter((line) => line.trim().length > 0)
            return Stream.fromIterable(lines)
          }),
          Stream.mapEffect((line) =>
            Effect.log("stderr line (suppressed from output)").pipe(
              Effect.annotateLogs({ line: line.slice(0, 200) })
            )
          ),
          Stream.runDrain,
          Effect.tap(() => Effect.log("stderr stream completed")),
          Effect.tapError((err) =>
            Queue.offer(eventQueue, new PlanFailed({ message: `stderr stream error: ${String(err)}` }))
          ),
          Effect.catchAll((err) => Effect.logError(`stderr stream error: ${String(err)}`)),
          Effect.forkDaemon
        )

        yield* Effect.gen(function*() {
          const exitCode = yield* process.exitCode
          yield* Effect.log("Plan session process exited").pipe(
            Effect.annotateLogs({ exitCode: String(exitCode) })
          )
          yield* Ref.set(sessionRef, Option.none())
          yield* Scope.close(processScope, Exit.void)
          if (exitCode === 0) {
            yield* Queue.offer(eventQueue, new PlanCompleted({ exitCode }))
          } else {
            yield* Queue.offer(
              eventQueue,
              new PlanFailed({ message: `lalph plan exited with code ${String(exitCode)}` })
            )
          }
        }).pipe(
          Effect.tapError((err) =>
            Effect.gen(function*() {
              yield* Ref.set(sessionRef, Option.none())
              yield* Queue.offer(eventQueue, new PlanFailed({ message: `Process error: ${String(err)}` }))
            })
          ),
          Effect.catchAll((err) => Effect.logError(`Process error: ${String(err)}`)),
          Effect.forkDaemon
        )
      })

    const answer = (text: string) =>
      Effect.gen(function*() {
        const current = yield* Ref.get(sessionRef)
        if (Option.isNone(current)) {
          return yield* new PlanSessionError({
            message: "No active plan session",
            cause: null
          })
        }
        const encoder = new TextEncoder()
        yield* Queue.offer(current.value.stdinQueue, encoder.encode(text + "\n"))
      })

    const sendFollowUp = (text: string) =>
      Effect.gen(function*() {
        const current = yield* Ref.get(sessionRef)
        if (Option.isNone(current)) {
          return yield* new PlanSessionError({
            message: "No active plan session",
            cause: null
          })
        }
        const encoder = new TextEncoder()
        const line = JSON.stringify({ type: "follow_up", text }) + "\n"
        yield* Queue.offer(current.value.stdinQueue, encoder.encode(line))
      })

    const interrupt = (text: string) =>
      Effect.gen(function*() {
        const current = yield* Ref.get(sessionRef)
        if (Option.isNone(current)) {
          return yield* new PlanSessionError({
            message: "No active plan session",
            cause: null
          })
        }
        const encoder = new TextEncoder()
        const line = JSON.stringify({ type: "shim_interrupt", text }) + "\n"
        yield* Queue.offer(current.value.stdinQueue, encoder.encode(line))
      })

    const approve = Effect.gen(function*() {
      const current = yield* Ref.get(sessionRef)
      if (Option.isNone(current)) {
        return yield* new PlanSessionError({
          message: "No active plan session",
          cause: null
        })
      }
      const encoder = new TextEncoder()
      yield* Queue.offer(current.value.stdinQueue, encoder.encode(JSON.stringify({ type: "shim_approve" }) + "\n"))
    })

    const reject = Effect.gen(function*() {
      const current = yield* Ref.get(sessionRef)
      if (Option.isNone(current)) {
        return yield* new PlanSessionError({
          message: "No active plan session",
          cause: null
        })
      }
      const encoder = new TextEncoder()
      yield* Queue.offer(current.value.stdinQueue, encoder.encode(JSON.stringify({ type: "shim_abort" }) + "\n"))
      yield* closeActiveSession
    })

    const isActive = Ref.get(sessionRef).pipe(Effect.map(Option.isSome))

    const events: Stream.Stream<PlanEvent, PlanSessionError> = Stream.fromQueue(eventQueue).pipe(
      Stream.mapError((err) => new PlanSessionError({ message: `Event stream error: ${String(err)}`, cause: err }))
    )

    return PlanSession.of({
      start: (planText) => start(planText).pipe(Effect.annotateLogs({ service: "PlanSession" })),
      answer: (text) => answer(text).pipe(Effect.annotateLogs({ service: "PlanSession" })),
      sendFollowUp: (text) => sendFollowUp(text).pipe(Effect.annotateLogs({ service: "PlanSession" })),
      interrupt: (text) => interrupt(text).pipe(Effect.annotateLogs({ service: "PlanSession" })),
      approve: approve.pipe(Effect.annotateLogs({ service: "PlanSession" })),
      reject: reject.pipe(Effect.annotateLogs({ service: "PlanSession" })),
      isActive,
      events
    })
  })
)
