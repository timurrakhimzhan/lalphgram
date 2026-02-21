import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { PassThrough } from "node:stream"
import {
  collectAnswers,
  FollowUpQueue,
  getShimControlType,
  LineReader,
  parseArgs,
  parseShimControl,
  ShimDeps,
  type ShimDepsService,
  shimProgram
} from "../src/main.js"

const SHIM_START_LINE = JSON.stringify({ type: "shim_start" }) + "\n"
const SHIM_ABORT_LINE = JSON.stringify({ type: "shim_abort" }) + "\n"

function createMockQuery(messages: ReadonlyArray<Record<string, unknown>>) {
  const gen = (async function*() {
    for (const m of messages) yield m
  })()

  return Object.assign(gen, {
    close: vi.fn(),
    interrupt: vi.fn(() => Promise.resolve()),
    setPermissionMode: vi.fn(() => Promise.resolve()),
    setModel: vi.fn(() => Promise.resolve()),
    setMaxThinkingTokens: vi.fn(() => Promise.resolve()),
    initializationResult: vi.fn(() => Promise.resolve({})),
    supportedCommands: vi.fn(() => Promise.resolve([])),
    supportedModels: vi.fn(() => Promise.resolve([])),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    accountInfo: vi.fn(() => Promise.resolve({})),
    rewindFiles: vi.fn(() => Promise.resolve({})),
    reconnectMcpServer: vi.fn(() => Promise.resolve()),
    toggleMcpServer: vi.fn(() => Promise.resolve()),
    setMcpServers: vi.fn(() => Promise.resolve({})),
    streamInput: vi.fn(() => Promise.resolve()),
    stopTask: vi.fn(() => Promise.resolve()),
    return: gen.return.bind(gen),
    throw: gen.throw.bind(gen),
    next: gen.next.bind(gen),
    [Symbol.asyncIterator]: () => gen
  })
}

function createMockDeps(overrides?: {
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string | undefined>
  readonly messages?: ReadonlyArray<Record<string, unknown>>
}): {
  deps: ShimDepsService
  stdinStream: PassThrough
  written: Array<string>
  mockCreateQuery: ReturnType<typeof vi.fn>
  mockQuery: ReturnType<typeof createMockQuery>
} {
  const written: Array<string> = []
  const messages = overrides?.messages ?? [
    { type: "result", subtype: "success" }
  ]
  const mockQuery = createMockQuery(messages)
  const mockCreateQuery = vi.fn().mockReturnValue(mockQuery)
  const stdinStream = new PassThrough()

  // Pre-write shim_start so the handshake completes automatically
  stdinStream.write(SHIM_START_LINE)

  const deps: ShimDepsService = {
    args: overrides?.args ?? [],
    createQuery: mockCreateQuery,
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

  return { deps, stdinStream, written, mockCreateQuery, mockQuery }
}

function createCustomMockQuery(
  gen: AsyncGenerator<Record<string, unknown>>,
  streamInputFn?: (stream: AsyncIterable<unknown>) => Promise<void>
) {
  return Object.assign(gen, {
    close: vi.fn(),
    interrupt: vi.fn(() => Promise.resolve()),
    setPermissionMode: vi.fn(() => Promise.resolve()),
    setModel: vi.fn(() => Promise.resolve()),
    setMaxThinkingTokens: vi.fn(() => Promise.resolve()),
    initializationResult: vi.fn(() => Promise.resolve({})),
    supportedCommands: vi.fn(() => Promise.resolve([])),
    supportedModels: vi.fn(() => Promise.resolve([])),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    accountInfo: vi.fn(() => Promise.resolve({})),
    rewindFiles: vi.fn(() => Promise.resolve({})),
    reconnectMcpServer: vi.fn(() => Promise.resolve()),
    toggleMcpServer: vi.fn(() => Promise.resolve()),
    setMcpServers: vi.fn(() => Promise.resolve({})),
    streamInput: vi.fn(streamInputFn ?? (() => Promise.resolve())),
    stopTask: vi.fn(() => Promise.resolve()),
    return: gen.return.bind(gen),
    throw: gen.throw.bind(gen),
    next: gen.next.bind(gen),
    [Symbol.asyncIterator]: () => gen
  })
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

  it("intercepted lines do not appear in nextLine", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const intercepted: Array<string> = []
    reader.interceptor = (line) => {
      if (line.startsWith("INTERCEPT:")) {
        intercepted.push(line)
        return true
      }
      return false
    }

    // Act
    stream.write("INTERCEPT:secret\n")
    stream.write("normal line\n")
    await new Promise((r) => setTimeout(r, 10))
    const line = await reader.nextLine()

    // Assert
    expect(line).toBe("normal line")
    expect(intercepted).toEqual(["INTERCEPT:secret"])
    stream.end()
  })

  it("interceptor receives lines that are waiting", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    reader.interceptor = (line) => line === "skip"

    // Act
    const promise = reader.nextLine()
    stream.write("skip\n")
    stream.write("keep\n")
    const line = await promise

    // Assert
    expect(line).toBe("keep")
    stream.end()
  })
})

describe("FollowUpQueue", () => {
  it("yields offered messages via async iteration", async () => {
    // Arrange
    const queue = new FollowUpQueue()
    const msg = {
      type: "user" as const,
      message: { role: "user" as const, content: "hello" },
      parent_tool_use_id: null,
      session_id: "s1"
    }

    // Act
    queue.offer(msg)
    queue.close()
    const results: Array<unknown> = []
    for await (const m of queue) {
      results.push(m)
    }

    // Assert
    expect(results).toEqual([msg])
  })

  it("waits for offer when no messages pending", async () => {
    // Arrange
    const queue = new FollowUpQueue()
    const msg = {
      type: "user" as const,
      message: { role: "user" as const, content: "delayed" },
      parent_tool_use_id: null,
      session_id: "s1"
    }

    // Act
    const iter = queue[Symbol.asyncIterator]()
    const promise = iter.next()
    queue.offer(msg)
    const result = await promise

    // Assert
    expect(result.done).toBe(false)
    expect(result.value).toEqual(msg)
    queue.close()
  })

  it("signals done after close when empty", async () => {
    // Arrange
    const queue = new FollowUpQueue()

    // Act
    const iter = queue[Symbol.asyncIterator]()
    const promise = iter.next()
    queue.close()
    const result = await promise

    // Assert
    expect(result.done).toBe(true)
  })

  it("ignores offers after close", async () => {
    // Arrange
    const queue = new FollowUpQueue()
    queue.close()
    const msg = {
      type: "user" as const,
      message: { role: "user" as const, content: "too late" },
      parent_tool_use_id: null,
      session_id: "s1"
    }

    // Act
    queue.offer(msg)
    const results: Array<unknown> = []
    for await (const m of queue) {
      results.push(m)
    }

    // Assert
    expect(results).toEqual([])
  })
})

describe("collectAnswers", () => {
  it("reads 1 answer for single question", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }

    // Act
    const promise = collectAnswers(1, reader, stderr)
    stream.write("Option A\n")
    const result = await promise

    // Assert
    expect(result).toEqual({
      content: [{ type: "text", text: "User answered: Option A" }]
    })
    stream.end()
  })

  it("reads N answers for multi-question input", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }

    // Act
    const promise = collectAnswers(2, reader, stderr)
    stream.write("Option A\n")
    stream.write("Option B\n")
    const result = await promise

    // Assert
    expect(result).toEqual({
      content: [{ type: "text", text: "User answered: Option A; Option B" }]
    })
    stream.end()
  })

  it("stops reading when stream closes", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }

    // Act
    const promise = collectAnswers(2, reader, stderr)
    stream.write("Only one\n")
    stream.end()
    const result = await promise

    // Assert
    expect(result).toEqual({
      content: [{ type: "text", text: "User answered: Only one" }]
    })
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

describe("shimProgram", () => {
  it.effect("creates query with MCP server and disallowed tools", () => {
    const { deps, mockCreateQuery, stdinStream } = createMockDeps({
      args: ["--dangerously-skip-permissions", "Plan this"]
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(mockCreateQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Plan this",
          options: expect.objectContaining({
            model: "claude-sonnet-4-6",
            pathToClaudeCodeExecutable: "/usr/local/bin/claude",
            permissionMode: "bypassPermissions",
            disallowedTools: ["AskUserQuestion"],
            mcpServers: expect.objectContaining({
              "ask-user": expect.objectContaining({ type: "sdk", name: "ask-user" })
            })
          })
        })
      )
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("uses model from --model arg over env var", () => {
    const { deps, mockCreateQuery, stdinStream } = createMockDeps({
      args: ["--model", "claude-opus-4-6", "Hello"],
      env: { REAL_CLAUDE_PATH: "/usr/bin/claude", CLAUDE_MODEL: "claude-haiku-4-5" }
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(mockCreateQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ model: "claude-opus-4-6" })
        })
      )
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("uses CLAUDE_MODEL env var when no --model arg", () => {
    const { deps, mockCreateQuery, stdinStream } = createMockDeps({
      args: ["Hello"],
      env: { REAL_CLAUDE_PATH: "/usr/bin/claude", CLAUDE_MODEL: "claude-haiku-4-5" }
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(mockCreateQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ model: "claude-haiku-4-5" })
        })
      )
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("streams NDJSON to stdout and stops on result", () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "result", subtype: "success" }
    ]
    const { deps, stdinStream, written } = createMockDeps({
      args: ["Do something"],
      messages
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert — first line is shim_ready, then the 3 streamed messages
      expect(written).toHaveLength(4)
      expect(JSON.parse(written[0]!)).toEqual({ type: "shim_ready" })
      expect(JSON.parse(written[1]!)).toEqual(messages[0])
      expect(JSON.parse(written[2]!)).toEqual(messages[1])
      expect(JSON.parse(written[3]!)).toEqual(messages[2])
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("closes query via finalizer", () => {
    const { deps, mockQuery, stdinStream } = createMockDeps({
      args: ["Hello"]
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(mockQuery.close).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("fails with ShimError when REAL_CLAUDE_PATH is not set", () => {
    const { deps } = createMockDeps({ args: ["Hello"], env: {} })
    return Effect.gen(function*() {
      // Act
      const result = yield* shimProgram.pipe(Effect.either)

      // Assert
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "ShimError",
          message: "REAL_CLAUDE_PATH not set"
        })
      }
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("calls streamInput with follow-up queue", () => {
    const { deps, mockQuery, stdinStream } = createMockDeps({
      args: ["Do something"]
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(mockQuery.streamInput).toHaveBeenCalledTimes(1)
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("routes follow_up JSON lines to streamInput instead of collectAnswers", () => {
    const offered: Array<unknown> = []
    const stdinStream = new PassThrough()
    // Pre-write shim_start so the handshake completes
    stdinStream.write(SHIM_START_LINE)
    // Generator that delays before yielding result, so the follow_up line can be processed
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      // Write follow_up and wait for interceptor to process it
      stdinStream.write(`${JSON.stringify({ type: "follow_up", text: "also consider X" })}\n`)
      await delay(50)
      stdinStream.end()
      yield { type: "result", subtype: "success" }
    })()
    const mockQuery = Object.assign(gen, {
      close: vi.fn(),
      interrupt: vi.fn(() => Promise.resolve()),
      setPermissionMode: vi.fn(() => Promise.resolve()),
      setModel: vi.fn(() => Promise.resolve()),
      setMaxThinkingTokens: vi.fn(() => Promise.resolve()),
      initializationResult: vi.fn(() => Promise.resolve({})),
      supportedCommands: vi.fn(() => Promise.resolve([])),
      supportedModels: vi.fn(() => Promise.resolve([])),
      mcpServerStatus: vi.fn(() => Promise.resolve([])),
      accountInfo: vi.fn(() => Promise.resolve({})),
      rewindFiles: vi.fn(() => Promise.resolve({})),
      reconnectMcpServer: vi.fn(() => Promise.resolve()),
      toggleMcpServer: vi.fn(() => Promise.resolve()),
      setMcpServers: vi.fn(() => Promise.resolve({})),
      streamInput: vi.fn(async (stream: AsyncIterable<unknown>) => {
        for await (const msg of stream) {
          offered.push(msg)
        }
      }),
      stopTask: vi.fn(() => Promise.resolve()),
      return: gen.return.bind(gen),
      throw: gen.throw.bind(gen),
      next: gen.next.bind(gen),
      [Symbol.asyncIterator]: () => gen
    })
    const mockCreateQuery = vi.fn().mockReturnValue(mockQuery)
    const deps: ShimDepsService = {
      args: ["Do something"],
      createQuery: mockCreateQuery,
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(offered).toHaveLength(1)
      expect(offered[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "also consider X" },
        parent_tool_use_id: null,
        session_id: "test-session"
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("writes shim_ready to stdout before query creation", () => {
    // Arrange
    const { deps, stdinStream, written } = createMockDeps({
      args: ["Do something"]
    })
    stdinStream.end()

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(written.length).toBeGreaterThanOrEqual(1)
      expect(JSON.parse(written[0]!)).toEqual({ type: "shim_ready" })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("exits cleanly on shim_abort", () => {
    // Arrange
    const written: Array<string> = []
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_ABORT_LINE)
    stdinStream.end()

    const mockCreateQuery = vi.fn()
    const deps: ShimDepsService = {
      args: ["Do something"],
      createQuery: mockCreateQuery,
      stdout: {
        write: vi.fn((data: string) => {
          written.push(data)
          return true
        })
      },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert — shim_ready written, but no query created
      expect(written).toHaveLength(1)
      expect(JSON.parse(written[0]!)).toEqual({ type: "shim_ready" })
      expect(mockCreateQuery).not.toHaveBeenCalled()
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("fails with ShimError on unexpected control message", () => {
    // Arrange
    const stdinStream = new PassThrough()
    stdinStream.write(JSON.stringify({ type: "unknown" }) + "\n")
    stdinStream.end()

    const deps: ShimDepsService = {
      args: ["Do something"],
      createQuery: vi.fn(),
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      const result = yield* shimProgram.pipe(Effect.either)

      // Assert
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toMatchObject({
          _tag: "ShimError",
          message: expect.stringContaining("Unexpected control message")
        })
      }
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })
})

describe("getShimControlType", () => {
  it("returns shim_start for valid start message", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_start" })

    // Act
    const result = getShimControlType(line)

    // Assert
    expect(result).toBe("shim_start")
  })

  it("returns shim_abort for valid abort message", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_abort" })

    // Act
    const result = getShimControlType(line)

    // Assert
    expect(result).toBe("shim_abort")
  })

  it("returns null for unknown type", () => {
    // Arrange
    const line = JSON.stringify({ type: "follow_up", text: "hello" })

    // Act
    const result = getShimControlType(line)

    // Assert
    expect(result).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    // Arrange
    const line = "not json"

    // Act
    const result = getShimControlType(line)

    // Assert
    expect(result).toBeNull()
  })

  it("returns null for empty string", () => {
    // Act
    const result = getShimControlType("")

    // Assert
    expect(result).toBeNull()
  })
})

describe("parseShimControl", () => {
  it("returns shim_start with text when present", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_start", text: "Go ahead!" })

    // Act
    const result = parseShimControl(line)

    // Assert
    expect(result).toEqual({ type: "shim_start", text: "Go ahead!" })
  })

  it("returns shim_start without text when text field is absent", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_start" })

    // Act
    const result = parseShimControl(line)

    // Assert
    expect(result).toEqual({ type: "shim_start" })
  })

  it("returns shim_abort", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_abort" })

    // Act
    const result = parseShimControl(line)

    // Assert
    expect(result).toEqual({ type: "shim_abort" })
  })

  it("returns null for follow_up type", () => {
    // Arrange
    const line = JSON.stringify({ type: "follow_up", text: "hello" })

    // Act
    const result = parseShimControl(line)

    // Assert
    expect(result).toBeNull()
  })

  it("returns null for invalid JSON", () => {
    // Act
    const result = parseShimControl("not json")

    // Assert
    expect(result).toBeNull()
  })

  it("returns null for empty string", () => {
    // Act
    const result = parseShimControl("")

    // Assert
    expect(result).toBeNull()
  })
})

describe("shimProgram post-handshake control", () => {
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it.effect("offers approve text and closes queue on post-handshake shim_start", () => {
    // Arrange
    const offered: Array<unknown> = []
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_start", text: "Approved! Build it." }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen, async (stream) => {
      for await (const msg of stream) offered.push(msg)
    })
    const mockCreateQuery = vi.fn().mockReturnValue(mockQuery)
    const deps: ShimDepsService = {
      args: ["Plan this"],
      createQuery: mockCreateQuery,
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(offered).toHaveLength(1)
      expect(offered[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Approved! Build it." },
        session_id: "test-session"
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("uses default approve text when shim_start has no text field", () => {
    // Arrange
    const offered: Array<unknown> = []
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_start" }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen, async (stream) => {
      for await (const msg of stream) offered.push(msg)
    })
    const mockCreateQuery = vi.fn().mockReturnValue(mockQuery)
    const deps: ShimDepsService = {
      args: ["Plan this"],
      createQuery: mockCreateQuery,
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(offered).toHaveLength(1)
      expect(offered[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "The user has approved. Proceed with implementation." },
        session_id: "test-session"
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("closes queue without offering on post-handshake shim_abort", () => {
    // Arrange
    const offered: Array<unknown> = []
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(SHIM_ABORT_LINE)
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen, async (stream) => {
      for await (const msg of stream) offered.push(msg)
    })
    const mockCreateQuery = vi.fn().mockReturnValue(mockQuery)
    const deps: ShimDepsService = {
      args: ["Plan this"],
      createQuery: mockCreateQuery,
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(offered).toHaveLength(0)
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("handles follow_up then shim_start in sequence", () => {
    // Arrange
    const offered: Array<unknown> = []
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "follow_up", text: "Also consider edge cases" }) + "\n")
      await delay(50)
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_start", text: "Looks good, proceed" }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen, async (stream) => {
      for await (const msg of stream) offered.push(msg)
    })
    const mockCreateQuery = vi.fn().mockReturnValue(mockQuery)
    const deps: ShimDepsService = {
      args: ["Plan this"],
      createQuery: mockCreateQuery,
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      stdin: stdinStream,
      env: { REAL_CLAUDE_PATH: "/usr/local/bin/claude" }
    }

    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      expect(offered).toHaveLength(2)
      expect(offered[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Also consider edge cases" }
      })
      expect(offered[1]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Looks good, proceed" }
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })
})
