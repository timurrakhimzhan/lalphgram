/**
 * Schema definitions for claude-shim control messages.
 * @since 1.0.0
 */
import { Schema } from "effect"

const ShimStart = Schema.Struct({
  type: Schema.Literal("shim_start"),
  text: Schema.optional(Schema.String)
})

const ShimAbort = Schema.Struct({
  type: Schema.Literal("shim_abort")
})

const ShimInterrupt = Schema.Struct({
  type: Schema.Literal("shim_interrupt"),
  text: Schema.optional(Schema.String)
})

export const ShimControl = Schema.Union(ShimStart, ShimAbort, ShimInterrupt)
export type ShimControl = typeof ShimControl.Type

export const FollowUp = Schema.Struct({
  type: Schema.Literal("follow_up"),
  text: Schema.String
})
export type FollowUp = typeof FollowUp.Type

export const ShimMessage = Schema.Union(ShimStart, ShimAbort, ShimInterrupt, FollowUp)
export type ShimMessage = typeof ShimMessage.Type

export const decodeShimMessage = Schema.decodeUnknownEither(Schema.parseJson(ShimMessage))
