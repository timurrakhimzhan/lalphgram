/**
 * Project schemas matching lalph's Project domain
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export class LalphProject extends Schema.Class<LalphProject>("LalphProject")({
  id: Schema.String,
  enabled: Schema.Boolean,
  targetBranch: Schema.Option(Schema.String),
  concurrency: Schema.Int.pipe(Schema.positive()),
  gitFlow: Schema.Literal("pr", "commit"),
  reviewAgent: Schema.Boolean,
  labelFilter: Schema.optionalWith(Schema.String, { default: () => "lalph" }),
  autoMergeLabel: Schema.optionalWith(Schema.String, { default: () => "auto-merge" })
}) {}
