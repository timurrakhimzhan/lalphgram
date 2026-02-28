import { CommandExecutor, Error as PlatformError, FileSystem, Path } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Queue, Stream } from "effect"
import { AppContext } from "../src/services/AppContext.js"
import { LalphConfig, LalphConfigLive } from "../src/services/LalphConfig.js"

const appContextLayer = Layer.succeed(
  AppContext,
  AppContext.of({
    projectRoot: "/projects/my-app",
    configDir: "/projects/my-app/.lalph/config"
  })
)

const fakeCommandExecutor: CommandExecutor.CommandExecutor = {
  [CommandExecutor.TypeId]: CommandExecutor.TypeId,
  exitCode: () => Effect.succeed(CommandExecutor.ExitCode(0)),
  start: () => Effect.die("not implemented"),
  string: () => Effect.succeed("https://github.com/owner/repo.git\n"),
  lines: () => Effect.succeed(["https://github.com/owner/repo.git"]),
  stream: () => Stream.empty,
  streamLines: () => Stream.empty
}

const fakeCommandExecutorLayer = Layer.succeed(
  CommandExecutor.CommandExecutor,
  fakeCommandExecutor
)

const defaultFileContents: Record<string, string> = {
  "github.accessToken": JSON.stringify({ token: "ghp_initial" }),
  "settings.issueSource": JSON.stringify("linear"),
  "linear.accessToken": JSON.stringify({ token: "lin_initial", expiresAt: "2026-01-01", refreshToken: "r" })
}

const makeTestLayer = (
  watchEvents: Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError>,
  fileContents: Record<string, string> = {}
) => {
  const mergedContents = { ...defaultFileContents, ...fileContents }
  return LalphConfigLive.pipe(
    Layer.provide(Layer.mergeAll(
      FileSystem.layerNoop({
        readFileString: (path) => {
          for (const [key, value] of Object.entries(mergedContents)) {
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
        watch: () => watchEvents
      }),
      Path.layer,
      appContextLayer,
      fakeCommandExecutorLayer
    ))
  )
}

describe("LalphConfig", () => {
  it.scoped("returns initial tokens from config files", () =>
    Effect.gen(function*() {
      // Arrange
      const layer = makeTestLayer(Stream.never)

      // Act
      const config = yield* LalphConfig.pipe(Effect.provide(layer))
      const githubToken = yield* config.githubToken
      const linearToken = yield* config.linearToken

      // Assert
      expect(githubToken).toBe("ghp_initial")
      expect(linearToken).toBe("lin_initial")
    }))

  it.scoped("exposes issueSource and repoFullName", () =>
    Effect.gen(function*() {
      // Arrange
      const layer = makeTestLayer(Stream.never)

      // Act
      const config = yield* LalphConfig.pipe(Effect.provide(layer))

      // Assert
      expect(config.issueSource).toBe("linear")
      expect(config.repoFullName).toBe("owner/repo")
    }))

  it.live("updates GitHub token when file changes", () =>
    Effect.gen(function*() {
      // Arrange
      const queue = yield* Queue.unbounded<FileSystem.WatchEvent>()
      const watchStream = Stream.fromQueue(queue)
      const newTokenJson = JSON.stringify({ token: "ghp_refreshed" })
      const layer = makeTestLayer(watchStream, {
        "github.accessToken": newTokenJson
      })

      yield* Effect.gen(function*() {
        const watcher = yield* LalphConfig

        // Act
        yield* Queue.offer(
          queue,
          FileSystem.WatchEventUpdate({
            path: `/projects/my-app/.lalph/config/${encodeURIComponent("github.accessToken")}`
          })
        )
        yield* Effect.sleep(Duration.millis(50))

        // Assert
        const token = yield* watcher.githubToken
        expect(token).toBe("ghp_refreshed")
      }).pipe(Effect.provide(layer))
    }))

  it.live("updates Linear token when file changes", () =>
    Effect.gen(function*() {
      // Arrange
      const queue = yield* Queue.unbounded<FileSystem.WatchEvent>()
      const watchStream = Stream.fromQueue(queue)
      const newTokenJson = JSON.stringify({
        token: "lin_refreshed",
        expiresAt: "2026-01-01",
        refreshToken: "refresh_new"
      })
      const layer = makeTestLayer(watchStream, {
        "linear.accessToken": newTokenJson
      })

      yield* Effect.gen(function*() {
        const watcher = yield* LalphConfig

        // Act
        yield* Queue.offer(
          queue,
          FileSystem.WatchEventUpdate({
            path: `/projects/my-app/.lalph/config/${encodeURIComponent("linear.accessToken")}`
          })
        )
        yield* Effect.sleep(Duration.millis(50))

        // Assert
        const token = yield* watcher.linearToken
        expect(token).toBe("lin_refreshed")
      }).pipe(Effect.provide(layer))
    }))

  it.scoped("ignores changes to unrelated files", () =>
    Effect.gen(function*() {
      // Arrange
      const events = [
        FileSystem.WatchEventUpdate({
          path: "/projects/my-app/.lalph/config/settings.issueSource"
        })
      ]
      const layer = makeTestLayer(Stream.fromIterable(events))
      const watcher = yield* LalphConfig.pipe(Effect.provide(layer))

      // Act & Assert
      const githubToken = yield* watcher.githubToken
      const linearToken = yield* watcher.linearToken
      expect(githubToken).toBe("ghp_initial")
      expect(linearToken).toBe("lin_initial")
    }))

  it.scoped("keeps old token when file read fails", () =>
    Effect.gen(function*() {
      // Arrange
      const events = [
        FileSystem.WatchEventUpdate({
          path: `/projects/my-app/.lalph/config/${encodeURIComponent("github.accessToken")}`
        })
      ]
      let githubReadCount = 0
      const layer = LalphConfigLive.pipe(
        Layer.provide(Layer.mergeAll(
          FileSystem.layerNoop({
            readFileString: (path) => {
              if (path.includes(encodeURIComponent("github.accessToken"))) {
                githubReadCount++
                if (githubReadCount <= 1) {
                  return Effect.succeed(JSON.stringify({ token: "ghp_initial" }))
                }
                return Effect.fail(
                  new PlatformError.SystemError({
                    reason: "NotFound",
                    module: "FileSystem",
                    method: "readFileString",
                    pathOrDescriptor: path
                  })
                )
              }
              for (const [key, value] of Object.entries(defaultFileContents)) {
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
            watch: () => Stream.fromIterable(events)
          }),
          Path.layer,
          appContextLayer,
          fakeCommandExecutorLayer
        ))
      )

      // Act
      const watcher = yield* LalphConfig.pipe(Effect.provide(layer))

      // Assert — old token stays valid since watcher read fails
      const token = yield* watcher.githubToken
      expect(token).toBe("ghp_initial")
    }))
})
