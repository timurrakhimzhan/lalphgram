/**
 * Credential and runtime config schemas
 * @since 1.0.0
 */
import { Context, Schema } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export class Credentials extends Schema.Class<Credentials>("Credentials")({
  backend: Schema.Literal("linear", "github"),
  githubToken: Schema.String,
  telegramBotToken: Schema.String,
  telegramChatId: Schema.String,
  linearApiKey: Schema.optionalWith(Schema.String, { default: () => "" }),
  watchedRepos: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] })
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class RuntimeConfig extends Schema.Class<RuntimeConfig>("RuntimeConfig")({
  pollIntervalSeconds: Schema.Number,
  triggerKeyword: Schema.String,
  timerDelaySeconds: Schema.Number
}) {}

/**
 * @since 1.0.0
 * @category context
 */
export class AppCredentials extends Context.Tag("AppCredentials")<AppCredentials, Credentials>() {}

/**
 * @since 1.0.0
 * @category context
 */
export class AppRuntimeConfig extends Context.Tag("AppRuntimeConfig")<AppRuntimeConfig, RuntimeConfig>() {}
