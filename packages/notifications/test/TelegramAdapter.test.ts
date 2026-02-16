import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import { IncomingMessage, MessengerAdapter, MessengerAdapterError } from "../src/services/MessengerAdapter.js"
import { TelegramAdapterLive } from "../src/services/TelegramAdapter.js"
import { TelegramConfig, TelegramConfigSchema } from "../src/services/TelegramConfig.js"

const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 1 })
const launchMock = vi.fn().mockResolvedValue(undefined)
const stopMock = vi.fn()
const onMock = vi.fn()

vi.mock("telegraf", () => ({
  Telegraf: vi.fn().mockImplementation(() => ({
    telegram: { sendMessage: sendMessageMock },
    launch: launchMock,
    stop: stopMock,
    on: onMock
  }))
}))

const makeStoreWithConfig = (config: TelegramConfigSchema | null) => {
  let currentConfig = config
  return TelegramConfig.of({
    get: Effect.sync(() => currentConfig !== null ? Option.some(currentConfig) : Option.none()),
    set: vi.fn((c: TelegramConfigSchema) =>
      Effect.sync(() => {
        currentConfig = c
      })
    )
  })
}

const configWithChatId = new TelegramConfigSchema({ botToken: "test-bot-token", chatId: "12345" })
const configNoChatId = new TelegramConfigSchema({ botToken: "test-bot-token", chatId: null })

const storeWithChatIdLayer = Layer.succeed(TelegramConfig, makeStoreWithConfig(configWithChatId))
const storeNoChatIdLayer = Layer.succeed(TelegramConfig, makeStoreWithConfig(configNoChatId))

describe("MessengerAdapter", () => {
  it.effect("sendMessage delegates to the adapter implementation", () => {
    // Arrange
    const sendMessageFn = vi.fn(() => Effect.succeed(undefined))
    const mockAdapter = MessengerAdapter.of({
      sendMessage: sendMessageFn,
      incomingMessages: Stream.empty
    })
    const layer = Layer.succeed(MessengerAdapter, mockAdapter)

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      yield* adapter.sendMessage("Hello <b>World</b>")

      // Assert
      expect(sendMessageFn).toHaveBeenCalledWith("Hello <b>World</b>")
    }).pipe(
      Effect.provide(layer)
    )
  })

  it.effect("sendMessage wraps errors in MessengerAdapterError", () => {
    // Arrange
    const mockAdapter = MessengerAdapter.of({
      sendMessage: vi.fn(() => Effect.fail(new MessengerAdapterError({ message: "Send failed", cause: null }))),
      incomingMessages: Stream.empty
    })
    const layer = Layer.succeed(MessengerAdapter, mockAdapter)

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      const error = yield* adapter.sendMessage("test").pipe(Effect.flip)

      // Assert
      expect(error).toBeInstanceOf(MessengerAdapterError)
      expect(error.message).toBe("Send failed")
    }).pipe(
      Effect.provide(layer)
    )
  })

  it.effect("incomingMessages stream emits IncomingMessage values", () => {
    // Arrange
    const msg1 = new IncomingMessage({ chatId: "123", text: "Hello", from: "alice" })
    const msg2 = new IncomingMessage({ chatId: "123", text: "World", from: "bob" })
    const mockAdapter = MessengerAdapter.of({
      sendMessage: vi.fn(() => Effect.succeed(undefined)),
      incomingMessages: Stream.make(msg1, msg2)
    })
    const layer = Layer.succeed(MessengerAdapter, mockAdapter)

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      const messages = yield* Stream.runCollect(adapter.incomingMessages)

      // Assert
      expect([...messages]).toEqual([msg1, msg2])
    }).pipe(
      Effect.provide(layer)
    )
  })
})

describe("TelegramAdapterLive", () => {
  beforeEach(() => {
    sendMessageMock.mockClear()
    launchMock.mockClear()
    stopMock.mockClear()
    onMock.mockClear()
  })

  it.effect("sendMessage calls bot.telegram.sendMessage with correct parameters", () => {
    // Arrange
    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeWithChatIdLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      yield* adapter.sendMessage("Hello from test")

      // Assert
      expect(sendMessageMock).toHaveBeenCalledWith("12345", "Hello from test", { parse_mode: "HTML" })
    }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  })

  it.effect("sendMessage fails when chatId not configured", () => {
    // Arrange
    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeNoChatIdLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      const error = yield* adapter.sendMessage("test").pipe(Effect.flip)

      // Assert
      expect(error).toBeInstanceOf(MessengerAdapterError)
      expect(error.message).toContain("not configured")
    }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  })

  it.effect("sendMessage picks up chatId after store update", () => {
    // Arrange
    const store = makeStoreWithConfig(configNoChatId)
    const storeLayer = Layer.succeed(TelegramConfig, store)
    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act — update store with chatId, then send
      yield* store.set(new TelegramConfigSchema({ botToken: "test-bot-token", chatId: "99999" }))
      yield* adapter.sendMessage("Hello after discovery")

      // Assert
      expect(sendMessageMock).toHaveBeenCalledWith("99999", "Hello after discovery", { parse_mode: "HTML" })
    }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  })

  it.effect("incomingMessages emits when bot receives a text message", () => {
    // Arrange
    onMock.mockImplementation((_event: string, handler: (ctx: unknown) => void) => {
      queueMicrotask(() => {
        handler({
          message: { text: "Hello from user" },
          chat: { id: 67890 },
          from: { username: "testuser", first_name: "Test" }
        })
      })
    })

    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeWithChatIdLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act — collect one message from the stream
      const messages = yield* adapter.incomingMessages.pipe(
        Stream.take(1),
        Stream.runCollect
      )

      // Assert
      expect([...messages]).toEqual([
        new IncomingMessage({ chatId: "67890", text: "Hello from user", from: "testuser" })
      ])
    }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  })
})
