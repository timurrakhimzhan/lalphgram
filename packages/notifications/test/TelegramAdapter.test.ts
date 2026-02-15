import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import { AppCredentials, Credentials } from "../src/schemas/CredentialSchemas.js"
import { IncomingMessage, MessengerAdapter, MessengerAdapterError } from "../src/services/MessengerAdapter.js"

import { TelegramAdapterLive } from "../src/services/TelegramAdapter.js"

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

const credentials = new Credentials({
  backend: "github",
  githubToken: "test-gh-token",
  telegramBotToken: "test-bot-token",
  telegramChatId: "12345"
})

const credentialsLayer = Layer.succeed(AppCredentials, credentials)

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
      Layer.provide(credentialsLayer)
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
      Layer.provide(credentialsLayer)
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
