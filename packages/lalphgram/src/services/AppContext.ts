/**
 * Application context — resolves project root and config directory paths
 * @since 1.0.0
 */
import { FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Layer } from "effect"

/**
 * @since 1.0.0
 * @category errors
 */
export class AppContextError extends Data.TaggedError("AppContextError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface AppContextService {
  readonly projectRoot: string
  readonly configDir: string
}

/**
 * @since 1.0.0
 * @category context
 */
export class AppContext extends Context.Tag("AppContext")<
  AppContext,
  AppContextService
>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const AppContextLive = Layer.effect(
  AppContext,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    let current = pathService.resolve(".")
    let lalphPath: string | undefined

    while (true) {
      const candidate = pathService.join(current, ".lalph")
      const exists = yield* fs.exists(candidate)
      if (exists) {
        lalphPath = candidate
        break
      }
      const parent = pathService.dirname(current)
      if (parent === current) break
      current = parent
    }

    if (lalphPath === undefined) {
      return yield* new AppContextError({
        message: "Could not find .lalph/ directory. Are you inside a lalph project?",
        cause: null
      })
    }

    return AppContext.of({
      projectRoot: pathService.dirname(lalphPath),
      configDir: pathService.join(lalphPath, "config")
    })
  })
)
