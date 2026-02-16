import { Error as PlatformError, FileSystem, Path } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { AppContext } from "../src/services/AppContext.js"
import { TelegramConfig, TelegramConfigLive, TelegramConfigSchema } from "../src/services/TelegramConfig.js"

const appContextLayer = Layer.succeed(
  AppContext,
  AppContext.of({
    projectRoot: "/projects/my-app",
    configDir: "/projects/my-app/.lalph/config"
  })
)

const makeStoreLayer = (fileContents: Record<string, string>, writeTracker?: {
  paths: Array<string>
  contents: Array<string>
}) =>
  TelegramConfigLive.pipe(
    Layer.provide(Layer.mergeAll(
      FileSystem.layerNoop({
        readFileString: (path) => {
          for (const [key, value] of Object.entries(fileContents)) {
            if (path.includes(encodeURIComponent(key))) {
              return Effect.succeed(value)
            }
          }
          return Effect.fail(
            new PlatformError.SystemError({
              reason: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path
            })
          )
        },
        writeFileString: (path, content) => {
          writeTracker?.paths.push(path)
          writeTracker?.contents.push(content)
          return Effect.void
        }
      }),
      Path.layer,
      appContextLayer
    ))
  )

describe("TelegramConfig", () => {
  it.effect("get returns Some when config file exists", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* TelegramConfig

      // Act
      const result = yield* store.get

      // Assert
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.botToken).toBe("bot123")
        expect(result.value.chatId).toBe("chat456")
      }
    }).pipe(Effect.provide(makeStoreLayer({
      "notify.telegram": JSON.stringify({ botToken: "bot123", chatId: "chat456" })
    }))))

  it.effect("get returns Some with null chatId", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* TelegramConfig

      // Act
      const result = yield* store.get

      // Assert
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.botToken).toBe("bot123")
        expect(result.value.chatId).toBeNull()
      }
    }).pipe(Effect.provide(makeStoreLayer({
      "notify.telegram": JSON.stringify({ botToken: "bot123", chatId: null })
    }))))

  it.effect("get returns None when file does not exist", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* TelegramConfig

      // Act
      const result = yield* store.get

      // Assert
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(makeStoreLayer({}))))

  it.effect("set writes config to file", () => {
    // Arrange
    const paths: Array<string> = []
    const contents: Array<string> = []
    const writeTracker = { paths, contents }

    return Effect.gen(function*() {
      const store = yield* TelegramConfig

      // Act
      yield* store.set(new TelegramConfigSchema({ botToken: "new-bot", chatId: "new-chat" }))

      // Assert
      expect(writeTracker.paths).toHaveLength(1)
      expect(writeTracker.paths[0]).toContain(encodeURIComponent("notify.telegram"))
      expect(JSON.parse(writeTracker.contents[0]!)).toEqual({ botToken: "new-bot", chatId: "new-chat" })
    }).pipe(Effect.provide(makeStoreLayer({}, writeTracker)))
  })

  it.effect("get returns cached value after set", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* TelegramConfig

      // Act
      yield* store.set(new TelegramConfigSchema({ botToken: "cached-bot", chatId: "cached-chat" }))
      const result = yield* store.get

      // Assert
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.botToken).toBe("cached-bot")
        expect(result.value.chatId).toBe("cached-chat")
      }
    }).pipe(Effect.provide(makeStoreLayer({}))))

  it.effect("set with null chatId persists correctly", () => {
    // Arrange
    const paths: Array<string> = []
    const contents: Array<string> = []
    const writeTracker = { paths, contents }

    return Effect.gen(function*() {
      const store = yield* TelegramConfig

      // Act
      yield* store.set(new TelegramConfigSchema({ botToken: "my-bot", chatId: null }))

      // Assert
      expect(JSON.parse(writeTracker.contents[0]!)).toEqual({ botToken: "my-bot", chatId: null })
    }).pipe(Effect.provide(makeStoreLayer({}, writeTracker)))
  })
})
