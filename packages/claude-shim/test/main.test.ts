import { describe, expect, it, vi } from "@effect/vitest"
import { Effect, Layer, Queue, Ref } from "effect"
import { PassThrough } from "node:stream"
import { collectAnswers, ShimDeps, type ShimDepsService, shimProgram } from "../src/main.js"

const SHIM_START_LINE = JSON.stringify({ type: "shim_start" }) + "\n"
const SHIM_ABORT_LINE = JSON.stringify({ type: "shim_abort" }) + "\n"

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

const collectPromptMessages = (mockCreateQuery: ReturnType<typeof vi.fn>) =>
  Effect.tryPromise({
    try: async () => {
      const callArg: unknown = mockCreateQuery.mock.calls[0]?.[0]
      if (typeof callArg !== "object" || callArg === null || !("prompt" in callArg)) return []
      const { prompt } = callArg
      if (!isAsyncIterable(prompt)) return []
      const msgs: Array<unknown> = []
      for await (const msg of prompt) msgs.push(msg)
      return msgs
    },
    catch: () => new Error("Failed to collect prompt messages")
  })

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
  gen: AsyncGenerator<Record<string, unknown>>
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
    streamInput: vi.fn(() => Promise.resolve()),
    stopTask: vi.fn(() => Promise.resolve()),
    return: gen.return.bind(gen),
    throw: gen.throw.bind(gen),
    next: gen.next.bind(gen),
    [Symbol.asyncIterator]: () => gen
  })
}

describe("collectAnswers", () => {
  it.effect("reads 1 answer for single question", () =>
    Effect.gen(function*() {
      // Arrange
      const answerQueue = yield* Queue.unbounded<string>()
      const closedRef = yield* Ref.make(false)
      const stderr = { write: vi.fn(() => true) }

      // Act
      yield* Queue.offer(answerQueue, "Option A")
      const result = yield* Effect.tryPromise({
        try: () => collectAnswers(1, answerQueue, closedRef, stderr),
        catch: () => new Error("collectAnswers failed")
      })

      // Assert
      expect(result).toEqual({
        content: [{ type: "text", text: "User answered: Option A" }]
      })
    }))

  it.effect("reads N answers for multi-question input", () =>
    Effect.gen(function*() {
      // Arrange
      const answerQueue = yield* Queue.unbounded<string>()
      const closedRef = yield* Ref.make(false)
      const stderr = { write: vi.fn(() => true) }

      // Act
      yield* Queue.offer(answerQueue, "Option A")
      yield* Queue.offer(answerQueue, "Option B")
      const result = yield* Effect.tryPromise({
        try: () => collectAnswers(2, answerQueue, closedRef, stderr),
        catch: () => new Error("collectAnswers failed")
      })

      // Assert
      expect(result).toEqual({
        content: [{ type: "text", text: "User answered: Option A; Option B" }]
      })
    }))

  it.effect("stops reading when closed with empty line", () =>
    Effect.gen(function*() {
      // Arrange
      const answerQueue = yield* Queue.unbounded<string>()
      const closedRef = yield* Ref.make(false)
      const stderr = { write: vi.fn(() => true) }

      // Act
      yield* Queue.offer(answerQueue, "Only one")
      yield* Ref.set(closedRef, true)
      yield* Queue.offer(answerQueue, "")
      const result = yield* Effect.tryPromise({
        try: () => collectAnswers(2, answerQueue, closedRef, stderr),
        catch: () => new Error("collectAnswers failed")
      })

      // Assert
      expect(result).toEqual({
        content: [{ type: "text", text: "User answered: Only one" }]
      })
    }))
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
          prompt: expect.objectContaining({
            [Symbol.asyncIterator]: expect.any(Function)
          }),
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

  it.effect("passes initial prompt as first message in prompt iterable", () => {
    const { deps, mockCreateQuery, stdinStream } = createMockDeps({
      args: ["Do something"]
    })
    stdinStream.end()
    return Effect.gen(function*() {
      // Act
      yield* shimProgram

      // Assert
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Do something" },
        session_id: ""
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("routes follow_up JSON lines to prompt iterable instead of collectAnswers", () => {
    const stdinStream = new PassThrough()
    // Pre-write shim_start so the handshake completes
    stdinStream.write(SHIM_START_LINE)
    // Generator that delays before yielding result, so the follow_up line can be processed
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      // Write follow_up and wait for routing to process it
      stdinStream.write(`${JSON.stringify({ type: "follow_up", text: "also consider X" })}\n`)
      await delay(50)
      stdinStream.end()
      yield { type: "result", subtype: "success" }
    })()
    const mockQuery = createCustomMockQuery(gen)
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
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Do something" },
        session_id: ""
      })
      expect(messages[1]).toMatchObject({
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

describe("shimProgram post-handshake control", () => {
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it.effect("offers approve text and closes queue on shim_approve", () => {
    // Arrange
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_approve", text: "Approved! Build it." }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen)
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
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Plan this" },
        session_id: ""
      })
      expect(messages[1]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Approved! Build it." },
        session_id: "test-session"
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("uses default approve text when shim_approve has no text field", () => {
    // Arrange
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_approve" }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen)
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
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Plan this" },
        session_id: ""
      })
      expect(messages[1]).toMatchObject({
        type: "user",
        message: { role: "user", content: "The user has approved. Proceed with implementation." },
        session_id: "test-session"
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("closes queue without offering on post-handshake shim_abort", () => {
    // Arrange
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(SHIM_ABORT_LINE)
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen)
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

      // Assert — only the initial prompt, no approve message
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Plan this" },
        session_id: ""
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("calls q.interrupt() and offers text on shim_interrupt", () => {
    // Arrange
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_interrupt", text: "urgent fix needed" }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen)
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
      expect(mockQuery.interrupt).toHaveBeenCalledTimes(1)
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Plan this" },
        session_id: ""
      })
      expect(messages[1]).toMatchObject({
        type: "user",
        message: { role: "user", content: "urgent fix needed" },
        session_id: "test-session"
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })

  it.effect("handles follow_up then shim_approve in sequence", () => {
    // Arrange
    const stdinStream = new PassThrough()
    stdinStream.write(SHIM_START_LINE)

    const gen = (async function*() {
      yield { type: "system", subtype: "init", session_id: "test-session" }
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "follow_up", text: "Also consider edge cases" }) + "\n")
      await delay(50)
      yield { type: "result", subtype: "success" }
      stdinStream.write(JSON.stringify({ type: "shim_approve", text: "Looks good, proceed" }) + "\n")
      await delay(50)
    })()

    const mockQuery = createCustomMockQuery(gen)
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
      const messages = yield* collectPromptMessages(mockCreateQuery)
      expect(messages).toHaveLength(3)
      expect(messages[0]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Plan this" },
        session_id: ""
      })
      expect(messages[1]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Also consider edge cases" }
      })
      expect(messages[2]).toMatchObject({
        type: "user",
        message: { role: "user", content: "Looks good, proceed" }
      })
    }).pipe(Effect.provide(Layer.succeed(ShimDeps, deps)))
  })
})
