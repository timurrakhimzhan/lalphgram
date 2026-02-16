/**
 * Credential and runtime config schemas
 * @since 1.0.0
 */
import { Context, Schema } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export class LalphGithubToken extends Schema.Class<LalphGithubToken>("LalphGithubToken")({
  token: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class LalphLinearToken extends Schema.Class<LalphLinearToken>("LalphLinearToken")({
  token: Schema.String,
  expiresAt: Schema.String,
  refreshToken: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class RuntimeConfig extends Schema.Class<RuntimeConfig>("RuntimeConfig")({
  pollIntervalSeconds: Schema.Number,
  triggerKeyword: Schema.String,
  timerDelaySeconds: Schema.Number,
  autoMergeEnabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  autoMergeWaitMinutes: Schema.optionalWith(Schema.Number, { default: () => 10 })
}) {}

/**
 * @since 1.0.0
 * @category context
 */
export class AppRuntimeConfig extends Context.Tag("AppRuntimeConfig")<AppRuntimeConfig, RuntimeConfig>() {}
