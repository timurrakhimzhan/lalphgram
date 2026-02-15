import { KeyValueStore } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Credentials } from "../src/schemas/CredentialSchemas.js"
import { CredentialStore, CredentialStoreError, CredentialStoreLive } from "../src/services/CredentialStore.js"

const makeTestLayer = () =>
  CredentialStoreLive.pipe(
    Layer.provide(KeyValueStore.layerMemory)
  )

const testCredentials = new Credentials({
  backend: "github",
  githubToken: "test-gh-token",
  telegramBotToken: "test-bot-token",
  telegramChatId: "12345"
})

describe("CredentialStore", () => {
  it.effect("stores and retrieves credentials", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* CredentialStore

      // Act
      yield* store.set(testCredentials)
      const result = yield* store.get

      // Assert
      expect(result.backend).toBe("github")
      expect(result.githubToken).toBe("test-gh-token")
      expect(result.telegramBotToken).toBe("test-bot-token")
      expect(result.telegramChatId).toBe("12345")
    }).pipe(
      Effect.provide(makeTestLayer())
    ))

  it.effect("fails with CredentialStoreError when no credentials stored", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* CredentialStore

      // Act
      const error = yield* store.get.pipe(Effect.flip)

      // Assert
      expect(error).toBeInstanceOf(CredentialStoreError)
      expect(error.message).toBe("No credentials stored")
    }).pipe(
      Effect.provide(makeTestLayer())
    ))

  it.effect("reports has as true when credentials exist", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* CredentialStore
      yield* store.set(testCredentials)

      // Act
      const result = yield* store.has

      // Assert
      expect(result).toBe(true)
    }).pipe(
      Effect.provide(makeTestLayer())
    ))

  it.effect("reports has as false when no credentials exist", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* CredentialStore

      // Act
      const result = yield* store.has

      // Assert
      expect(result).toBe(false)
    }).pipe(
      Effect.provide(makeTestLayer())
    ))

  it.effect("clears stored credentials", () =>
    Effect.gen(function*() {
      // Arrange
      const store = yield* CredentialStore
      yield* store.set(testCredentials)

      // Act
      yield* store.clear
      const result = yield* store.has

      // Assert
      expect(result).toBe(false)
    }).pipe(
      Effect.provide(makeTestLayer())
    ))
})
