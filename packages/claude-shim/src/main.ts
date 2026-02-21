#!/usr/bin/env node
/**
 * SDK-based claude binary replacement — outputs stream-json NDJSON to stdout
 * for PlanSession to parse. Handles multi-turn via stdin.
 * @since 1.0.0
 */
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk"
import type { HookCallback, SDKSession } from "@anthropic-ai/claude-agent-sdk"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

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

export function createAskUserQuestionHook(
  lineReader: LineReader,
  stderr: { write(data: string): boolean }
): HookCallback {
  return async (input) => {
    const toolInput = "tool_input" in input ? input.tool_input : undefined
    const questions = toolInput != null
        && typeof toolInput === "object"
        && "questions" in toolInput
        && Array.isArray(toolInput.questions)
      ? toolInput.questions
      : undefined
    const questionCount = questions?.length ?? 1

    stderr.write(`claude-shim: AskUserQuestion hook blocking for ${questionCount} answer(s)\n`)

    const answers: Array<string> = []
    while (answers.length < questionCount) {
      const line = await lineReader.nextLine()
      const trimmed = line.trim()
      if (trimmed.length === 0 && lineReader.isClosed) break
      if (trimmed.length === 0) continue
      answers.push(trimmed)
    }

    stderr.write(`claude-shim: AskUserQuestion hook received: ${answers.join("; ")}\n`)

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `User answered: ${answers.join("; ")}`
      }
    }
  }
}

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

export interface SessionDeps {
  readonly createSession: typeof unstable_v2_createSession
  readonly stdout: { write(data: string): boolean }
  readonly stderr: { write(data: string): boolean }
  readonly stdin: NodeJS.ReadableStream
  readonly env: Record<string, string | undefined>
}

async function streamToStdout(
  session: SDKSession,
  stdout: { write(data: string): boolean }
): Promise<boolean> {
  for await (const msg of session.stream()) {
    stdout.write(JSON.stringify(msg) + "\n")
    if (msg.type === "result") {
      return true
    }
  }
  return false
}

export async function run(
  args: ReadonlyArray<string>,
  deps: SessionDeps
): Promise<void> {
  const { createSession, stderr, stdin, stdout } = deps
  const parsed = parseArgs(args)

  const realClaudePath = deps.env["REAL_CLAUDE_PATH"]
  if (!realClaudePath) {
    stderr.write("Error: REAL_CLAUDE_PATH environment variable is required\n")
    throw new Error("REAL_CLAUDE_PATH not set")
  }

  const model = parsed.model ?? deps.env["CLAUDE_MODEL"] ?? "claude-sonnet-4-6"

  const lineReader = new LineReader(stdin)
  const askHook = createAskUserQuestionHook(lineReader, stderr)

  const session = createSession({
    model,
    pathToClaudeCodeExecutable: realClaudePath,
    hooks: {
      PreToolUse: [{
        matcher: "AskUserQuestion",
        hooks: [askHook],
        timeout: 300
      }]
    },
    ...(parsed.dangerouslySkipPermissions
      ? { permissionMode: "bypassPermissions" }
      : {})
  })

  try {
    await session.send(parsed.prompt)
    let done = await streamToStdout(session, stdout)

    if (!done) {
      while (!lineReader.isClosed) {
        const line = await lineReader.nextLine()
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        await session.send(trimmed)
        done = await streamToStdout(session, stdout)
        if (done) break
      }
    }
  } finally {
    session.close()
  }
}

// Run only when executed as main module
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] === __filename) {
  run(process.argv.slice(2), {
    createSession: unstable_v2_createSession,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env
  }).catch((err: unknown) => {
    process.stderr.write(`claude-shim error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
