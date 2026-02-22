/**
 * SDK-based claude binary replacement — outputs stream-json NDJSON to stdout
 * for PlanSession to parse. Uses MCP tool for AskUserQuestion instead of hooks.
 * @since 1.0.0
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { Query, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import * as NodeStream from "@effect/platform-node/NodeStream"
import { Context, Data, Effect, Either, Queue, Ref, Stream } from "effect"
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

export interface ShimDepsService {
  readonly args: ReadonlyArray<string>
  readonly createQuery: typeof query
  readonly stdout: { write(data: string): boolean }
  readonly stderr: { write(data: string): boolean }
  readonly stdin: NodeJS.ReadableStream
  readonly env: Record<string, string | undefined>
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

export const collectAnswers = async (
  questionCount: number,
  answerQueue: Queue.Queue<string>,
  closedRef: Ref.Ref<boolean>,
  stderr: { write(data: string): boolean }
) => {
  stderr.write(`claude-shim: ask_user MCP tool blocking for ${questionCount} answer(s)\n`)
  const answers: Array<string> = []
  while (answers.length < questionCount) {
    const line = await Effect.runPromise(Queue.take(answerQueue))
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      const closed = Effect.runSync(Ref.get(closedRef))
      if (closed) break
      continue
    }
    answers.push(trimmed)
  }
  stderr.write(`claude-shim: ask_user received: ${answers.join("; ")}\n`)
  return {
    content: [{ type: "text" as const, text: `User answered: ${answers.join("; ")}` }]
  }
}

export const createAskUserMcpServer = (
  answerQueue: Queue.Queue<string>,
  closedRef: Ref.Ref<boolean>,
  stderr: { write(data: string): boolean }
) =>
  createSdkMcpServer({
    name: "ask-user",
    tools: [
      tool(
        "ask_user",
        "Ask the user a question and wait for their response via Telegram. Always provide 2-4 options for the user to choose from.",
        askUserQuestionSchema,
        (args, _extra) => collectAnswers(args.questions.length || 1, answerQueue, closedRef, stderr)
      )
    ]
  })

const FollowUpStop: unique symbol = Symbol.for("FollowUpStop")
type FollowUpItem = SDKUserMessage | typeof FollowUpStop

export const shimProgram = Effect.gen(function*() {
  const deps = yield* ShimDeps
  const parsed = parseArgs(deps.args)

  const realClaudePath = deps.env["REAL_CLAUDE_PATH"]
  if (!realClaudePath) {
    yield* Effect.logError("REAL_CLAUDE_PATH environment variable is required")
    return yield* new ShimError({ message: "REAL_CLAUDE_PATH not set", cause: null })
  }

  const model = parsed.model ?? deps.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-6"

  // State refs
  const answerQueue = yield* Queue.unbounded<string>()
  const closedRef = yield* Ref.make(false)
  const routingActive = yield* Ref.make(false)
  const queryHandleRef = yield* Ref.make<{ interrupt: () => Promise<void> } | null>(null)
  const sessionIdRef = yield* Ref.make("")

  // Follow-up queue: messages or FollowUpStop to signal termination
  const followUpQueue = yield* Queue.unbounded<FollowUpItem>()

  const followUpIterable: AsyncIterable<SDKUserMessage> = Stream.fromQueue(followUpQueue).pipe(
    Stream.takeWhile((item): item is SDKUserMessage => item !== FollowUpStop),
    Stream.toAsyncIterable
  )

  const mcpServer = createAskUserMcpServer(answerQueue, closedRef, deps.stderr)

  // Fork stdin reader daemon
  yield* NodeStream.fromReadable<ShimError>(
    () => deps.stdin,
    (err) => new ShimError({ message: "stdin read error", cause: err })
  ).pipe(
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
            deps.stderr.write(`claude-shim: follow_up intercepted: ${msg.text.slice(0, 100)}\n`)
            yield* Queue.offer(followUpQueue, {
              type: "user",
              message: { role: "user", content: msg.text },
              parent_tool_use_id: null,
              session_id: sessionId
            })
            return
          }
          case "shim_start": {
            const approveText = msg.text ?? "The user has approved. Proceed with implementation."
            deps.stderr.write("claude-shim: shim_start intercepted\n")
            yield* Queue.offer(followUpQueue, {
              type: "user",
              message: { role: "user", content: approveText },
              parent_tool_use_id: null,
              session_id: sessionId
            })
            yield* Queue.offer(followUpQueue, FollowUpStop)
            return
          }
          case "shim_interrupt": {
            deps.stderr.write("claude-shim: shim_interrupt intercepted\n")
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
            deps.stderr.write("claude-shim: shim_abort intercepted\n")
            yield* Queue.offer(followUpQueue, FollowUpStop)
            return
          }
        }
      })
    ),
    Stream.runDrain,
    Effect.ensuring(
      Effect.gen(function*() {
        yield* Ref.set(closedRef, true)
        yield* Queue.offer(answerQueue, "")
      })
    ),
    Effect.forkDaemon
  )

  // Handshake: signal readiness and wait for control message
  deps.stdout.write(JSON.stringify({ type: "shim_ready" }) + "\n")
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

  const q: Query = deps.createQuery({
    prompt: followUpIterable,
    options: {
      model,
      pathToClaudeCodeExecutable: realClaudePath,
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

  yield* Stream.fromAsyncIterable(q, (err) => new ShimError({ message: "Stream error", cause: err })).pipe(
    Stream.tap((msg: SDKMessage) =>
      Effect.gen(function*() {
        if (msg.type === "system" && msg.subtype === "init") {
          yield* Ref.set(sessionIdRef, msg.session_id)
        }
        deps.stdout.write(JSON.stringify(msg) + "\n")
      })
    ),
    Stream.runDrain
  )
}).pipe(Effect.scoped)
