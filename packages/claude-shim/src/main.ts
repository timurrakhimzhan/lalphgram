/**
 * SDK-based claude binary replacement — outputs stream-json NDJSON to stdout
 * for PlanSession to parse. Uses MCP tool for AskUserQuestion instead of hooks.
 * @since 1.0.0
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type { Query, query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Context, Data, Effect, Stream } from "effect"
import { createInterface } from "node:readline"
import { z } from "zod/v4"

export class LineReader {
  private readonly buffer: Array<string> = []
  private waiting: ((line: string) => void) | null = null
  private _closed = false

  constructor(input: NodeJS.ReadableStream) {
    const rl = createInterface({ input, terminal: false })
    rl.on("line", (line) => {
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

  yield* Stream.fromAsyncIterable(q, (err) => new ShimError({ message: "Stream error", cause: err })).pipe(
    Stream.tap((msg: SDKMessage) => Effect.sync(() => deps.stdout.write(JSON.stringify(msg) + "\n"))),
    Stream.takeUntil((msg: SDKMessage) => msg.type === "result"),
    Stream.runDrain
  )
}).pipe(Effect.scoped)
