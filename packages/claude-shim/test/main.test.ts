import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import type { SessionDeps } from "../src/main.js"
import { createAskUserQuestionHook, LineReader, parseArgs, run } from "../src/main.js"

async function* asyncGen<T>(items: ReadonlyArray<T>): AsyncGenerator<T, void> {
  for (const item of items) {
    yield item
  }
}

function createMockDeps(overrides?: {
  readonly env?: Record<string, string | undefined>
}): {
  deps: SessionDeps
  stdinStream: PassThrough
  written: Array<string>
  mockSend: ReturnType<typeof vi.fn>
  mockStream: ReturnType<typeof vi.fn>
  mockClose: ReturnType<typeof vi.fn>
} {
  const written: Array<string> = []
  const mockSend = vi.fn(() => Promise.resolve())
  const mockStream = vi.fn()
  const mockClose = vi.fn()

  const mockSession = {
    sessionId: "test-session",
    send: mockSend,
    stream: mockStream,
    close: mockClose,
    [Symbol.asyncDispose]: vi.fn(() => Promise.resolve())
  }

  const mockCreateSession = vi.fn().mockReturnValue(mockSession)
  const stdinStream = new PassThrough()

  const deps: SessionDeps = {
    createSession: mockCreateSession,
    stdout: {
      write: vi.fn((data: string) => {
        written.push(data)
        return true
      })
    },
    stderr: { write: vi.fn(() => true) },
    stdin: stdinStream,
    env: overrides?.env ?? { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
  }

  return { deps, stdinStream, written, mockSend, mockStream, mockClose }
}

describe("LineReader", () => {
  it("reads buffered line immediately", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    stream.write("hello\n")

    // Allow readline to process
    await new Promise((r) => setTimeout(r, 10))

    // Act
    const line = await reader.nextLine()

    // Assert
    expect(line).toBe("hello")
    stream.end()
  })

  it("waits when buffer is empty and resolves when line arrives", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)

    // Act
    const promise = reader.nextLine()
    stream.write("delayed\n")
    const line = await promise

    // Assert
    expect(line).toBe("delayed")
    stream.end()
  })

  it("returns empty string when stream closes while waiting", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)

    // Act
    const promise = reader.nextLine()
    stream.end()
    const line = await promise

    // Assert
    expect(line).toBe("")
  })

  it("reports isClosed after stream ends and buffer drains", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    stream.write("line1\n")
    stream.end()

    // Allow readline to process
    await new Promise((r) => setTimeout(r, 10))

    // Act & Assert — buffer has content, so not closed yet
    expect(reader.isClosed).toBe(false)
    await reader.nextLine()
    expect(reader.isClosed).toBe(true)
  })
})

describe("createAskUserQuestionHook", () => {
  it("reads 1 answer for single-question input", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }
    const hook = createAskUserQuestionHook(reader, stderr)

    const input = {
      hook_event_name: "PreToolUse" as const,
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Pick one?", options: [] }] },
      tool_use_id: "tu_1",
      session_id: "s1",
      transcript_path: "/tmp/t",
      cwd: "/tmp"
    }

    // Act
    const promise = hook(input, "tu_1", { signal: AbortSignal.timeout(5000) })
    stream.write("Option A\n")
    const result = await promise

    // Assert
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "User answered: Option A"
      }
    })
    stream.end()
  })

  it("reads 2 answers for multi-question input", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }
    const hook = createAskUserQuestionHook(reader, stderr)

    const input = {
      hook_event_name: "PreToolUse" as const,
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "First?", options: [] },
          { question: "Second?", options: [] }
        ]
      },
      tool_use_id: "tu_2",
      session_id: "s1",
      transcript_path: "/tmp/t",
      cwd: "/tmp"
    }

    // Act
    const promise = hook(input, "tu_2", { signal: AbortSignal.timeout(5000) })
    stream.write("Option A\n")
    stream.write("Option B\n")
    const result = await promise

    // Assert
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "User answered: Option A; Option B"
      }
    })
    stream.end()
  })

  it("defaults to 1 question when questions array is missing", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }
    const hook = createAskUserQuestionHook(reader, stderr)

    const input = {
      hook_event_name: "PreToolUse" as const,
      tool_name: "AskUserQuestion",
      tool_input: {},
      tool_use_id: "tu_3",
      session_id: "s1",
      transcript_path: "/tmp/t",
      cwd: "/tmp"
    }

    // Act
    const promise = hook(input, "tu_3", { signal: AbortSignal.timeout(5000) })
    stream.write("My answer\n")
    const result = await promise

    // Assert
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "User answered: My answer"
      }
    })
    stream.end()
  })
})

describe("parseArgs", () => {
  it("extracts positional prompt", () => {
    // Arrange
    const args = ["Hello world"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("Hello world")
    expect(result.dangerouslySkipPermissions).toBe(false)
    expect(result.model).toBeNull()
  })

  it("detects --dangerously-skip-permissions", () => {
    // Arrange
    const args = ["--dangerously-skip-permissions", "Do something"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.dangerouslySkipPermissions).toBe(true)
    expect(result.prompt).toBe("Do something")
  })

  it("extracts --model value", () => {
    // Arrange
    const args = ["--model", "claude-opus-4-6", "Hello"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.model).toBe("claude-opus-4-6")
    expect(result.prompt).toBe("Hello")
  })

  it("skips --output-format and its value", () => {
    // Arrange
    const args = ["--output-format", "stream-json", "Hello"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("Hello")
  })

  it("skips -p, --print, and --verbose flags", () => {
    // Arrange
    const args = ["-p", "--verbose", "--print", "Hello"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("Hello")
  })

  it("handles -- separator for prompt", () => {
    // Arrange
    const args = ["--dangerously-skip-permissions", "--", "prompt", "text", "here"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("prompt text here")
    expect(result.dangerouslySkipPermissions).toBe(true)
  })
})

describe("run", () => {
  it("creates session with correct options including hooks", async () => {
    // Arrange
    const { deps, mockStream, stdinStream } = createMockDeps()
    mockStream.mockReturnValue(asyncGen([
      { type: "result", subtype: "success" }
    ]))
    stdinStream.end()

    // Act
    await run(["--dangerously-skip-permissions", "Plan this"], deps)

    // Assert
    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        permissionMode: "bypassPermissions",
        hooks: {
          PreToolUse: [expect.objectContaining({
            matcher: "AskUserQuestion",
            timeout: 300
          })]
        }
      })
    )
  })

  it("uses model from --model arg over env var", async () => {
    // Arrange
    const { deps, mockStream, stdinStream } = createMockDeps({
      env: { REAL_CLAUDE_PATH: "/usr/bin/claude", CLAUDE_MODEL: "claude-haiku-4-5" }
    })
    mockStream.mockReturnValue(asyncGen([
      { type: "result", subtype: "success" }
    ]))
    stdinStream.end()

    // Act
    await run(["--model", "claude-opus-4-6", "Hello"], deps)

    // Assert
    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-6" })
    )
  })

  it("uses CLAUDE_MODEL env var when no --model arg", async () => {
    // Arrange
    const { deps, mockStream, stdinStream } = createMockDeps({
      env: { REAL_CLAUDE_PATH: "/usr/bin/claude", CLAUDE_MODEL: "claude-haiku-4-5" }
    })
    mockStream.mockReturnValue(asyncGen([
      { type: "result", subtype: "success" }
    ]))
    stdinStream.end()

    // Act
    await run(["Hello"], deps)

    // Assert
    expect(deps.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" })
    )
  })

  it("sends initial prompt and streams NDJSON to stdout", async () => {
    // Arrange
    const { deps, mockSend, mockStream, stdinStream, written } = createMockDeps()
    const messages = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "result", subtype: "success" }
    ]
    mockStream.mockReturnValue(asyncGen(messages))
    stdinStream.end()

    // Act
    await run(["Do something"], deps)

    // Assert
    expect(mockSend).toHaveBeenCalledWith("Do something")
    expect(written).toHaveLength(3)
    expect(JSON.parse(written[0]!)).toEqual(messages[0])
    expect(JSON.parse(written[1]!)).toEqual(messages[1])
    expect(JSON.parse(written[2]!)).toEqual(messages[2])
  })

  it("handles multi-turn via stdin", async () => {
    // Arrange
    const { deps, mockSend, mockStream, stdinStream, written } = createMockDeps()
    stdinStream.write("my answer\n")
    stdinStream.end()

    mockStream
      .mockReturnValueOnce(asyncGen([
        { type: "assistant", message: { content: [{ type: "text", text: "What is your name?" }] } }
      ]))
      .mockReturnValueOnce(asyncGen([
        { type: "assistant", message: { content: [{ type: "text", text: "Hello, my answer" }] } },
        { type: "result", subtype: "success" }
      ]))

    // Act
    await run(["Start planning"], deps)

    // Assert
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend).toHaveBeenNthCalledWith(1, "Start planning")
    expect(mockSend).toHaveBeenNthCalledWith(2, "my answer")
    expect(written).toHaveLength(3)
  })

  it("closes session after completion", async () => {
    // Arrange
    const { deps, mockClose, mockStream, stdinStream } = createMockDeps()
    mockStream.mockReturnValue(asyncGen([
      { type: "result", subtype: "success" }
    ]))
    stdinStream.end()

    // Act
    await run(["Hello"], deps)

    // Assert
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it("throws when REAL_CLAUDE_PATH is not set", async () => {
    // Arrange
    const { deps, stdinStream } = createMockDeps({ env: {} })
    stdinStream.end()

    // Act & Assert
    await expect(run(["Hello"], deps)).rejects.toThrow("REAL_CLAUDE_PATH not set")
    expect(deps.stderr.write).toHaveBeenCalledWith(
      "Error: REAL_CLAUDE_PATH environment variable is required\n"
    )
  })

  it("closes session even when streaming errors", async () => {
    // Arrange
    const { deps, mockClose, mockStream, stdinStream } = createMockDeps()
    const failingIterable = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("stream failed"))
      })
    }
    mockStream.mockReturnValue(failingIterable)
    stdinStream.end()

    // Act & Assert
    await expect(run(["Hello"], deps)).rejects.toThrow("stream failed")
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it("skips empty stdin lines", async () => {
    // Arrange
    const { deps, mockSend, mockStream, stdinStream } = createMockDeps()
    stdinStream.write("\n")
    stdinStream.write("  \n")
    stdinStream.write("real answer\n")
    stdinStream.end()

    mockStream
      .mockReturnValueOnce(asyncGen([
        { type: "assistant", message: { content: [{ type: "text", text: "Question?" }] } }
      ]))
      .mockReturnValueOnce(asyncGen([
        { type: "result", subtype: "success" }
      ]))

    // Act
    await run(["Hello"], deps)

    // Assert
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend).toHaveBeenNthCalledWith(2, "real answer")
  })
})
