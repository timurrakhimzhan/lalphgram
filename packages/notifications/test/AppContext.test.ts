import { FileSystem, Path } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppContext, AppContextError, AppContextLive } from "../src/services/AppContext.js"

const makePathLayer = (resolveCwd: string) =>
  Layer.effect(
    Path.Path,
    Effect.gen(function*() {
      const realPath = yield* Path.Path
      return Path.Path.of({
        ...realPath,
        resolve: (...segments) => {
          if (segments.length === 1 && segments[0] === ".") {
            return resolveCwd
          }
          return realPath.resolve(...segments)
        }
      })
    }).pipe(Effect.provide(Path.layer))
  )

describe("AppContext", () => {
  it.effect("resolves projectRoot and configDir when .lalph exists", () =>
    Effect.gen(function*() {
      // Act
      const ctx = yield* AppContext

      // Assert
      expect(ctx.projectRoot).toBe("/projects/my-app")
      expect(ctx.configDir).toBe("/projects/my-app/.lalph/config")
    }).pipe(Effect.provide(AppContextLive.pipe(
      Layer.provide(Layer.merge(
        FileSystem.layerNoop({
          exists: (path) => Effect.succeed(path === "/projects/my-app/.lalph")
        }),
        makePathLayer("/projects/my-app")
      ))
    ))))

  it.effect("fails when .lalph directory does not exist", () =>
    Effect.gen(function*() {
      // Act
      const error = yield* Effect.gen(function*() {
        yield* AppContext
      }).pipe(
        Effect.provide(AppContextLive.pipe(
          Layer.provide(Layer.merge(
            FileSystem.layerNoop({
              exists: () => Effect.succeed(false)
            }),
            makePathLayer("/projects/my-app")
          ))
        )),
        Effect.flip
      )

      // Assert
      expect(error).toBeInstanceOf(AppContextError)
      expect(error.message).toContain("Could not find .lalph/ directory")
    }))
})
