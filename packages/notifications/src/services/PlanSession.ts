/**
 * Plan session manager — spawns `lalph plan` subprocess and bridges I/O
 * @since 1.0.0
 */
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Exit, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
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
export type PlanEvent = PlanTextOutput | PlanQuestion | PlanCompleted | PlanFailed

interface ActiveSession {
  readonly process: CommandExecutor.Process
  readonly scope: Scope.CloseableScope
}

/**
 * @since 1.0.0
 * @category services
 */
export interface PlanSessionService {
  readonly start: (planText: string) => Effect.Effect<void, PlanSessionError>
  readonly answer: (text: string) => Effect.Effect<void, PlanSessionError>
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

        yield* Ref.set(sessionRef, Option.some({ process, scope: processScope }))
        yield* Effect.log("Plan session process spawned").pipe(
          Effect.annotateLogs({ tempFile })
        )

        const decoder = new TextDecoder()

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
            Effect.gen(function*() {
              const parsed = yield* decodeJsonMessage(line).pipe(
                Effect.map(Option.some),
                Effect.catchTag("ParseError", (err) =>
                  Effect.logWarning("stdout line is not valid JSON, treating as raw text").pipe(
                    Effect.annotateLogs({ parseError: err.message.slice(0, 100) }),
                    Effect.map(() => Option.none<StreamJsonMessage>())
                  ))
              )
              if (Option.isNone(parsed)) {
                const cleaned = stripAnsi(line).trim()
                if (cleaned.length > 0) {
                  yield* Effect.log("stdout raw line (not JSON)").pipe(
                    Effect.annotateLogs({ line: cleaned.slice(0, 200) })
                  )
                  yield* Queue.offer(eventQueue, new PlanTextOutput({ text: cleaned }))
                }
                return
              }
              const msg = parsed.value
              yield* Effect.log("Parsed stream-json message").pipe(
                Effect.annotateLogs({
                  messageType: msg.type,
                  ...(msg.subtype != null ? { subtype: msg.subtype } : {})
                })
              )
              if (msg.type !== "assistant" || msg.message?.content == null) {
                return
              }
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text != null) {
                  yield* Effect.log("Emitting text block").pipe(
                    Effect.annotateLogs({ textLength: String(block.text.length) })
                  )
                  yield* Queue.offer(eventQueue, new PlanTextOutput({ text: block.text }))
                } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
                  yield* Effect.log("AskUserQuestion detected")
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
                  yield* Queue.offer(
                    eventQueue,
                    new PlanTextOutput({ text: `▶ ${block.name}` })
                  )
                }
              }
            })
          ),
          Stream.runDrain,
          Effect.tap(() =>
            Effect.log("stdout stream completed")
          ),
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
            Effect.gen(function*() {
              yield* Effect.log("stderr line").pipe(
                Effect.annotateLogs({ line: line.slice(0, 200) })
              )
              yield* Queue.offer(eventQueue, new PlanTextOutput({ text: line }))
            })
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
        yield* Stream.make(encoder.encode(text + "\n")).pipe(
          Stream.run(current.value.process.stdin),
          Effect.mapError((err) =>
            new PlanSessionError({ message: `Failed to write to stdin: ${String(err)}`, cause: err })
          )
        )
      })

    const isActive = Ref.get(sessionRef).pipe(Effect.map(Option.isSome))

    const events: Stream.Stream<PlanEvent, PlanSessionError> = Stream.fromQueue(eventQueue).pipe(
      Stream.mapError((err) => new PlanSessionError({ message: `Event stream error: ${String(err)}`, cause: err }))
    )

    return PlanSession.of({
      start: (planText) => start(planText).pipe(Effect.annotateLogs({ service: "PlanSession" })),
      answer: (text) => answer(text).pipe(Effect.annotateLogs({ service: "PlanSession" })),
      isActive,
      events
    })
  })
)
