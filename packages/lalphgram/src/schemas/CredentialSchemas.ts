/**
 * Credential schemas
 * @since 1.0.0
 */
import { Schema } from "effect"

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
