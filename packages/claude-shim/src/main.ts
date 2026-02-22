/**
 * SDK-based claude binary replacement — outputs stream-json NDJSON to stdout
 * for PlanSession to parse. Uses MCP tool for AskUserQuestion instead of hooks.
 * @since 1.0.0
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { Query, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

import type { PlatformError } from "@effect/platform/Error"
import { Config, Context, Data, Effect, Either, Fiber, Queue, Ref, Stream } from "effect"
import type * as Sink from "effect/Sink"
import { z } from "zod/v4"
import { parseArgs } from "./parseArgs.js"
import { decodeShimMessage } from "./schemas.js"

export { parseArgs } from "./parseArgs.js"
export type { ParsedArgs } from "./parseArgs.js"
export { decodeShimMessage } from "./schemas.js"

export class ShimError extends Data.TaggedError("ShimError")<{
  readonly message: string
  readonly cause: unknown
}> {}

// --- Query Service ---

export type QueryParams = Parameters<typeof query>[0]

export class ClaudeQuery extends Context.Tag("ClaudeQuery")<ClaudeQuery, {
  readonly create: (params: QueryParams) => Effect.Effect<Query, ShimError>
}>() {}

// --- Config ---

export const ShimConfig = Config.all({
  realClaudePath: Config.string("REAL_CLAUDE_PATH"),
  claudeModel: Config.withDefault(Config.string("CLAUDE_MODEL"), "claude-opus-4-6")
})

// --- IO Deps ---

export interface ShimDepsService {
  readonly args: ReadonlyArray<string>
  readonly stdin: Stream.Stream<Uint8Array>
  readonly stdout: Sink.Sink<void, string, never, PlatformError>
  readonly stderr: Sink.Sink<void, string, never, PlatformError>
}

export class ShimDeps extends Context.Tag("ShimDeps")<ShimDeps, ShimDepsService>() {}

const askUserQuestionSchema = {
  questions: z.array(z.object({
    question: z.string().describe("The question to ask the user"),
    header: z.string().optional().describe("Short label (max 12 chars) displayed as a tag, e.g. 'Auth method'"),
    options: z.array(z.object({
      label: z.string().describe("Concise display text (1-5 words)"),
      description: z.string().optional().describe("Explanation of what this option means")
    })).min(2).max(4).describe("The available choices. Must have 2-4 options."),
    multiSelect: z.boolean().optional().describe("Allow multiple selections")
  }))
}

const FollowUpStop: unique symbol = Symbol.for("FollowUpStop")
type FollowUpItem = SDKUserMessage | typeof FollowUpStop

export const shimProgram = Effect.gen(function*() {
  const deps = yield* ShimDeps
  const queryService = yield* ClaudeQuery
  const config = yield* ShimConfig
  const parsed = parseArgs(deps.args)

  const model = parsed.model ?? config.claudeModel

  // Output queues, drained through sinks as a single stream each
  const outQueue = yield* Queue.unbounded<string>()
  const errQueue = yield* Queue.unbounded<string>()
  const outFiber = yield* Stream.fromQueue(outQueue).pipe(
    Stream.run(deps.stdout),
    Effect.fork
  )
  const errFiber = yield* Stream.fromQueue(errQueue).pipe(
    Stream.run(deps.stderr),
    Effect.fork
  )
  yield* Effect.addFinalizer(() =>
    Effect.all([Queue.shutdown(outQueue), Queue.shutdown(errQueue)]).pipe(
      Effect.andThen(Fiber.joinAll([outFiber, errFiber]).pipe(Effect.ignore))
    )
  )
  const writeStdout = (data: string) => Queue.offer(outQueue, data).pipe(Effect.asVoid)
  const writeDebug = (msg: string) =>
    Queue.offer(errQueue, JSON.stringify({ type: "debug", message: msg }) + "\n").pipe(Effect.asVoid)

  // State refs
  const answerQueue = yield* Queue.unbounded<string>()
  const routingActive = yield* Ref.make(false)
  const queryHandleRef = yield* Ref.make<{ interrupt: () => Promise<void> } | null>(null)
  const sessionIdRef = yield* Ref.make("")

  // Follow-up queue: messages or FollowUpStop to signal termination
  const followUpQueue = yield* Queue.unbounded<FollowUpItem>()

  const followUpIterable: AsyncIterable<SDKUserMessage> = Stream.fromQueue(followUpQueue).pipe(
    Stream.takeWhile((item): item is SDKUserMessage => item !== FollowUpStop),
    Stream.toAsyncIterable
  )

  const collectAnswers = (questionCount: number) =>
    Stream.fromQueue(answerQueue).pipe(
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.take(questionCount),
      Stream.runCollect,
      Effect.map((chunk) => ({
        content: [{ type: "text" as const, text: `User answered: ${Array.from(chunk).join("; ")}` }]
      }))
    )

  const mcpServer = createSdkMcpServer({
    name: "ask-user",
    tools: [
      tool(
        "ask_user",
        "Ask the user a question and wait for their response via Telegram. Always provide 2-4 options for the user to choose from.",
        askUserQuestionSchema,
        (args, _extra) => Effect.runPromise(collectAnswers(args.questions.length || 1))
      )
    ]
  })

  // Fork stdin reader daemon
  yield* deps.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapEffect((line) =>
      Effect.gen(function*() {
        const isRouting = yield* Ref.get(routingActive)
        if (!isRouting) {
          yield* Queue.offer(answerQueue, line)
          return
        }

        const decoded = decodeShimMessage(line)
        if (Either.isLeft(decoded)) {
          yield* Queue.offer(answerQueue, line)
          return
        }

        const msg = decoded.right
        const sessionId = yield* Ref.get(sessionIdRef)

        switch (msg.type) {
          case "follow_up": {
            yield* writeDebug(`follow_up intercepted: ${msg.text.slice(0, 100)}`)
            yield* Queue.offer(followUpQueue, {
              type: "user",
              message: { role: "user", content: msg.text },
              parent_tool_use_id: null,
              session_id: sessionId
            })
            return
          }
          case "shim_approve": {
            const approveText = msg.text ?? "The user has approved. Proceed with implementation."
            yield* writeDebug("shim_approve intercepted")
            yield* Queue.offer(followUpQueue, {
              type: "user",
              message: { role: "user", content: approveText },
              parent_tool_use_id: null,
              session_id: sessionId
            })
            yield* Queue.offer(followUpQueue, FollowUpStop)
            return
          }
          case "shim_start": {
            // shim_start after handshake is unexpected — ignore
            return
          }
          case "shim_interrupt": {
            yield* writeDebug("shim_interrupt intercepted")
            const handle = yield* Ref.get(queryHandleRef)
            if (handle !== null) {
              yield* Effect.tryPromise({
                try: () => handle.interrupt(),
                catch: (err) => new ShimError({ message: "interrupt error", cause: err })
              }).pipe(Effect.catchTag("ShimError", (err) => Effect.logError("interrupt error", err)))
            }
            if (msg.text != null) {
              yield* Queue.offer(followUpQueue, {
                type: "user",
                message: { role: "user", content: msg.text },
                parent_tool_use_id: null,
                session_id: sessionId
              })
            }
            return
          }
          case "shim_abort": {
            yield* writeDebug("shim_abort intercepted")
            yield* Queue.offer(followUpQueue, FollowUpStop)
            return
          }
        }
      })
    ),
    Stream.runDrain,
    Effect.forkScoped
  )

  // Handshake: signal readiness and wait for control message
  yield* writeStdout(JSON.stringify({ type: "shim_ready" }) + "\n")
  const controlLine = yield* Queue.take(answerQueue)
  const controlDecoded = decodeShimMessage(controlLine)

  if (Either.isRight(controlDecoded) && controlDecoded.right.type === "shim_abort") return
  if (Either.isLeft(controlDecoded) || controlDecoded.right.type !== "shim_start") {
    return yield* new ShimError({
      message: `Unexpected control message: ${controlLine}`,
      cause: null
    })
  }

  // Offer initial prompt to follow-up queue
  yield* Queue.offer(followUpQueue, {
    type: "user",
    message: { role: "user", content: parsed.prompt },
    parent_tool_use_id: null,
    session_id: ""
  })

  const q = yield* queryService.create({
    prompt: followUpIterable,
    options: {
      model,
      pathToClaudeCodeExecutable: config.realClaudePath,
      mcpServers: { "ask-user": mcpServer },
      disallowedTools: ["AskUserQuestion"],
      ...(parsed.dangerouslySkipPermissions
        ? { permissionMode: "bypassPermissions" as const }
        : {})
    }
  })

  yield* Ref.set(queryHandleRef, { interrupt: () => q.interrupt() })
  yield* Ref.set(routingActive, true)

  yield* Effect.addFinalizer(() => Effect.sync(() => q.close()))
  yield* Effect.addFinalizer(() => Queue.offer(followUpQueue, FollowUpStop))
  yield* Effect.addFinalizer(() => Queue.shutdown(answerQueue))

  yield* Stream.fromAsyncIterable(q, (err) => new ShimError({ message: "Stream error", cause: err })).pipe(
    Stream.tap((msg: SDKMessage) =>
      Effect.gen(function*() {
        if (msg.type === "system" && msg.subtype === "init") {
          yield* Ref.set(sessionIdRef, msg.session_id)
        }
        yield* writeStdout(JSON.stringify(msg) + "\n")
      })
    ),
    Stream.runDrain
  )
}).pipe(Effect.scoped)
