/**
 * SDK-based claude binary replacement — outputs stream-json NDJSON to stdout
 * for PlanSession to parse. Uses MCP tool for AskUserQuestion instead of hooks.
 * @since 1.0.0
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { Query, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Data, Effect, Stream } from "effect"
import { createInterface } from "node:readline"
import { z } from "zod/v4"

export class LineReader {
  private readonly buffer: Array<string> = []
  private waiting: ((line: string) => void) | null = null
  private _closed = false
  interceptor: ((line: string) => boolean) | null = null

  constructor(input: NodeJS.ReadableStream) {
    const rl = createInterface({ input, terminal: false })
    rl.on("line", (line) => {
      if (this.interceptor?.(line)) return
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = null
        resolve(line)
      } else {
        this.buffer.push(line)
      }
    })
    rl.on("close", () => {
      this._closed = true
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = null
        resolve("")
      }
    })
  }

  get isClosed(): boolean {
    return this._closed && this.buffer.length === 0
  }

  nextLine(): Promise<string> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!)
    }
    if (this._closed) {
      return Promise.resolve("")
    }
    return new Promise<string>((resolve) => {
      this.waiting = resolve
    })
  }
}

const iterDone: IteratorReturnResult<undefined> = { value: undefined, done: true }

export class FollowUpQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: Array<SDKUserMessage> = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private _done = false

  offer(msg: SDKUserMessage): void {
    if (this._done) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.pending.push(msg)
    }
  }

  close(): void {
    this._done = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve(iterDone)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.pending.length > 0) {
          return Promise.resolve({ value: this.pending.shift()!, done: false })
        }
        if (this._done) {
          return Promise.resolve(iterDone)
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting = resolve
        })
      }
    }
  }
}

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

export interface ParsedArgs {
  readonly prompt: string
  readonly dangerouslySkipPermissions: boolean
  readonly model: string | null
}

export function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  let dangerouslySkipPermissions = false
  let prompt = ""
  let model: string | null = null
  let skipNext = false

  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const arg = args[i]!
    if (arg === "--dangerously-skip-permissions") {
      dangerouslySkipPermissions = true
    } else if (arg === "--output-format") {
      skipNext = true
    } else if (arg === "--model") {
      model = args[i + 1] ?? null
      skipNext = true
    } else if (arg === "--verbose" || arg === "-p" || arg === "--print") {
      // ignored — SDK handles output format and verbosity
    } else if (arg === "--") {
      // everything after -- is the prompt
      prompt = args.slice(i + 1).join(" ")
      break
    } else if (!arg.startsWith("-")) {
      prompt = arg
    }
  }

  return { prompt, dangerouslySkipPermissions, model }
}

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
  lineReader: LineReader,
  stderr: { write(data: string): boolean }
) => {
  stderr.write(`claude-shim: ask_user MCP tool blocking for ${questionCount} answer(s)\n`)
  const answers: Array<string> = []
  while (answers.length < questionCount) {
    const line = await lineReader.nextLine()
    const trimmed = line.trim()
    if (trimmed.length === 0 && lineReader.isClosed) break
    if (trimmed.length === 0) continue
    answers.push(trimmed)
  }
  stderr.write(`claude-shim: ask_user received: ${answers.join("; ")}\n`)
  return {
    content: [{ type: "text" as const, text: `User answered: ${answers.join("; ")}` }]
  }
}

export const createAskUserMcpServer = (
  lineReader: LineReader,
  stderr: { write(data: string): boolean }
) =>
  createSdkMcpServer({
    name: "ask-user",
    tools: [
      tool(
        "ask_user",
        "Ask the user a question and wait for their response via Telegram. Always provide 2-4 options for the user to choose from.",
        askUserQuestionSchema,
        (args, _extra) => collectAnswers(args.questions.length || 1, lineReader, stderr)
      )
    ]
  })

function getFollowUpText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  if (!("type" in value) || !("text" in value)) return null
  // Use JSON round-trip to get typed access without assertions
  const { text, type } = Object.fromEntries(Object.entries(value))
  if (type === "follow_up" && typeof text === "string") return text
  return null
}

export function getShimControlType(line: string): string | null {
  if (line.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== "object" || parsed === null) return null
    if (!("type" in parsed)) return null
    const { type } = Object.fromEntries(Object.entries(parsed))
    if (type === "shim_start" || type === "shim_abort") return type
    return null
  } catch {
    return null
  }
}

export function parseShimControl(
  line: string
): { readonly type: "shim_start" | "shim_abort"; readonly text?: string } | null {
  if (line.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== "object" || parsed === null) return null
    if (!("type" in parsed)) return null
    const entries = Object.fromEntries(Object.entries(parsed))
    if (entries["type"] === "shim_start") {
      return typeof entries["text"] === "string"
        ? { type: "shim_start", text: entries["text"] }
        : { type: "shim_start" }
    }
    if (entries["type"] === "shim_abort") return { type: "shim_abort" }
    return null
  } catch {
    return null
  }
}

export const shimProgram = Effect.gen(function*() {
  const deps = yield* ShimDeps
  const parsed = parseArgs(deps.args)

  const realClaudePath = deps.env["REAL_CLAUDE_PATH"]
  if (!realClaudePath) {
    yield* Effect.logError("REAL_CLAUDE_PATH environment variable is required")
    return yield* new ShimError({ message: "REAL_CLAUDE_PATH not set", cause: null })
  }

  const model = parsed.model ?? deps.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-6"
  const lineReader = new LineReader(deps.stdin)
  const mcpServer = createAskUserMcpServer(lineReader, deps.stderr)

  // Handshake: signal readiness and wait for control message
  deps.stdout.write(JSON.stringify({ type: "shim_ready" }) + "\n")
  const controlLine = yield* Effect.tryPromise({
    try: () => lineReader.nextLine(),
    catch: (err) => new ShimError({ message: "Failed to read control line", cause: err })
  })
  const controlType = getShimControlType(controlLine)
  if (controlType === "shim_abort") return
  if (controlType !== "shim_start") {
    return yield* new ShimError({
      message: `Unexpected control message: ${controlLine}`,
      cause: null
    })
  }

  const q: Query = deps.createQuery({
    prompt: parsed.prompt,
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

  yield* Effect.addFinalizer(() => Effect.sync(() => q.close()))

  const followUpQueue = new FollowUpQueue()
  let sessionId = ""

  lineReader.interceptor = (line) => {
    try {
      const parsed: unknown = JSON.parse(line)

      // Handle follow_up — queue stays open for more messages
      const followUpText = getFollowUpText(parsed)
      if (followUpText !== null) {
        deps.stderr.write(`claude-shim: follow_up intercepted: ${followUpText.slice(0, 100)}\n`)
        followUpQueue.offer({
          type: "user",
          message: { role: "user", content: followUpText },
          parent_tool_use_id: null,
          session_id: sessionId
        })
        return true
      }

      // Handle post-handshake control messages (shim_start / shim_abort)
      const control = parseShimControl(line)
      if (control !== null) {
        if (control.type === "shim_start") {
          const approveText = control.text ?? "The user has approved. Proceed with implementation."
          deps.stderr.write("claude-shim: shim_start intercepted\n")
          followUpQueue.offer({
            type: "user",
            message: { role: "user", content: approveText },
            parent_tool_use_id: null,
            session_id: sessionId
          })
          followUpQueue.close()
        } else {
          deps.stderr.write("claude-shim: shim_abort intercepted\n")
          followUpQueue.close()
        }
        return true
      }
    } catch {
      // not JSON — pass through to collectAnswers
    }
    return false
  }

  yield* Effect.tryPromise({
    try: () => q.streamInput(followUpQueue),
    catch: (err) => new ShimError({ message: "streamInput error", cause: err })
  }).pipe(
    Effect.catchAll((err) => Effect.logError(`streamInput error: ${String(err)}`)),
    Effect.forkScoped
  )

  yield* Effect.addFinalizer(() => Effect.sync(() => followUpQueue.close()))

  yield* Stream.fromAsyncIterable(q, (err) => new ShimError({ message: "Stream error", cause: err })).pipe(
    Stream.tap((msg: SDKMessage) =>
      Effect.sync(() => {
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id
        }
        deps.stdout.write(JSON.stringify(msg) + "\n")
      })
    ),
    Stream.runDrain
  )
}).pipe(Effect.scoped)
