import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { PassThrough } from "node:stream"
import {
  createAskUserHandler,
  LineReader,
  parseArgs,
  ShimDeps,
  type ShimDepsService,
  shimProgram
} from "../src/main.js"

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

describe("createAskUserHandler", () => {
  it("reads 1 answer for single-question input", async () => {
    // Arrange
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    const stderr = { write: vi.fn(() => true) }
    const handler = createAskUserHandler(reader, stderr)

    // Act
    const promise = handler({ questions: [{ question: "Pick one?" }] })
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
    const handler = createAskUserHandler(reader, stderr)

    // Act
    const promise = handler({
      questions: [
        { question: "First?" },
        { question: "Second?" }
      ]
    })
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
    const handler = createAskUserHandler(reader, stderr)

    // Act
    const promise = handler({ questions: [{ question: "Q1?" }, { question: "Q2?" }] })
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

      // Assert
      expect(written).toHaveLength(3)
      expect(JSON.parse(written[0]!)).toEqual(messages[0])
      expect(JSON.parse(written[1]!)).toEqual(messages[1])
      expect(JSON.parse(written[2]!)).toEqual(messages[2])
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
})
