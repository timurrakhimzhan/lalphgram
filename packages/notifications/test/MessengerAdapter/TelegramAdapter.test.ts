import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import {
  IncomingMessage,
  MessengerAdapter,
  MessengerAdapterError
} from "../../src/services/MessengerAdapter/MessengerAdapter.js"
import { TelegramAdapterLive } from "../../src/services/MessengerAdapter/TelegramAdapter.js"
import { TelegramConfig, TelegramConfigSchema } from "../../src/services/TelegramConfig.js"

const sendMessageMock = vi.fn().mockResolvedValue({ message_id: 1 })
const editMessageTextMock = vi.fn().mockResolvedValue(true)
const launchMock = vi.fn().mockResolvedValue(undefined)
const stopMock = vi.fn()
const onMock = vi.fn()
const actionMock = vi.fn()

vi.mock("telegraf", () => ({
  Telegraf: vi.fn().mockImplementation(() => ({
    telegram: { sendMessage: sendMessageMock, editMessageText: editMessageTextMock },
    launch: launchMock,
    stop: stopMock,
    on: onMock,
    action: actionMock
  })),
  Markup: {
    button: {
      callback: vi.fn((label: string, data: string) => ({ text: label, callback_data: data }))
    },
    inlineKeyboard: vi.fn((buttons: Array<Array<unknown>>) => ({ reply_markup: { inline_keyboard: buttons } }))
  }
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
    const sendMessageFn = vi.fn(() => Effect.succeed({ id: "0" }))
    const mockAdapter = MessengerAdapter.of({
      sendMessage: sendMessageFn,
      editMessage: vi.fn(() => Effect.void),
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
      editMessage: vi.fn(() => Effect.void),
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
      sendMessage: vi.fn(() => Effect.succeed({ id: "0" })),
      editMessage: vi.fn(() => Effect.void),
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
    editMessageTextMock.mockClear()
    launchMock.mockClear()
    stopMock.mockClear()
    onMock.mockClear()
    actionMock.mockClear()
  })

  it.effect("sendMessage calls bot.telegram.sendMessage and returns SentMessage", () => {
    // Arrange
    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeWithChatIdLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      const result = yield* adapter.sendMessage("Hello from test")

      // Assert
      expect(sendMessageMock).toHaveBeenCalledWith("12345", "Hello from test", { parse_mode: "HTML" })
      expect(result).toEqual({ id: "1" })
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

  it.effect("editMessage calls bot.telegram.editMessageText and removes inline keyboard", () => {
    // Arrange
    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeWithChatIdLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      yield* adapter.editMessage("42", "Answer received ✓")

      // Assert
      expect(editMessageTextMock).toHaveBeenCalledWith(
        "12345",
        42,
        undefined,
        "Answer received ✓",
        { reply_markup: { inline_keyboard: [] }, parse_mode: "HTML" }
      )
    }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  })

  it.effect("editMessage fails when chatId not configured", () => {
    // Arrange
    const layer = TelegramAdapterLive.pipe(
      Layer.provide(storeNoChatIdLayer)
    )

    return Effect.gen(function*() {
      // Arrange
      const adapter = yield* MessengerAdapter

      // Act
      const error = yield* adapter.editMessage("42", "text").pipe(Effect.flip)

      // Assert
      expect(error).toBeInstanceOf(MessengerAdapterError)
      expect(error.message).toContain("not configured")
    }).pipe(
      Effect.provide(layer),
      Effect.scoped
    )
  })
})
