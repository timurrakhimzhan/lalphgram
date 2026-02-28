/**
 * Telegram config persistence service following lalph TokenManager pattern
 * @since 1.0.0
 */
import { FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { AppContext } from "./AppContext.js"

/**
 * @since 1.0.0
 * @category schemas
 */
export class TelegramConfigSchema extends Schema.Class<TelegramConfigSchema>("TelegramConfigSchema")({
  botToken: Schema.String,
  chatId: Schema.NullOr(Schema.String)
}) {}

/**
 * @since 1.0.0
 * @category errors
 */
export class TelegramConfigError extends Data.TaggedError("TelegramConfigError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface TelegramConfigService {
  readonly get: Effect.Effect<Option.Option<TelegramConfigSchema>>
  readonly set: (config: TelegramConfigSchema) => Effect.Effect<void, TelegramConfigError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class TelegramConfig extends Context.Tag("TelegramConfig")<
  TelegramConfig,
  TelegramConfigService
>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const TelegramConfigLive = Layer.effect(
  TelegramConfig,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const appContext = yield* AppContext

    const filePath = pathService.join(appContext.configDir, encodeURIComponent("notify.telegram"))

    let currentConfig: TelegramConfigSchema | null = null

    const get = Effect.gen(function*() {
      if (currentConfig !== null) return Option.some(currentConfig)

      const content = yield* fs.readFileString(filePath).pipe(
        Effect.mapError((err) =>
          new TelegramConfigError({
            message: "Failed to read telegram config",
            cause: err
          })
        )
      )
      const json = yield* Effect.try({
        try: () => JSON.parse(content),
        catch: (err) =>
          new TelegramConfigError({
            message: "Failed to parse telegram config",
            cause: err
          })
      })
      const config = yield* Schema.decodeUnknown(TelegramConfigSchema)(json).pipe(
        Effect.mapError((err) =>
          new TelegramConfigError({
            message: "Failed to decode telegram config",
            cause: err
          })
        )
      )
      currentConfig = config
      return Option.some(config)
    }).pipe(
      Effect.catchTag(
        "TelegramConfigError",
        (err) =>
          Effect.logWarning(`No stored Telegram config: ${err.message}`).pipe(
            Effect.map(() => Option.none<TelegramConfigSchema>())
          )
      )
    )

    const set = (config: TelegramConfigSchema) =>
      Effect.gen(function*() {
        yield* fs.writeFileString(
          filePath,
          JSON.stringify({
            botToken: config.botToken,
            chatId: config.chatId
          })
        ).pipe(
          Effect.mapError((err) =>
            new TelegramConfigError({
              message: "Failed to write telegram config",
              cause: err
            })
          )
        )
        currentConfig = config
      })

    return TelegramConfig.of({ get, set })
  })
)
