/**
 * NDJSON parser for Claude Code `--output-format stream-json` output
 * @since 1.0.0
 */
import { Effect, flow, identity, Schema, Stream } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export const ContentBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown)
})

/**
 * @since 1.0.0
 * @category schemas
 */
export class StreamJsonMessage extends Schema.Class<StreamJsonMessage>("StreamJsonMessage")({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(ContentBlock))
    })
  )
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String)
})

/**
 * @since 1.0.0
 * @category schemas
 */
export const Question = Schema.Struct({
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(QuestionOption)),
  multiSelect: Schema.optional(Schema.Boolean)
})

/**
 * @since 1.0.0
 * @category schemas
 */
export const AskUserQuestionInput = Schema.Struct({
  questions: Schema.optional(Schema.Array(Question))
})

/**
 * @since 1.0.0
 * @category schemas
 */
export class StreamJsonInput extends Schema.Class<StreamJsonInput>("StreamJsonInput")({
  type: Schema.Literal("user"),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.String
  }),
  session_id: Schema.String,
  parent_tool_use_id: Schema.NullOr(Schema.String)
}) {}

const decodeJsonMessage = Schema.decodeUnknown(Schema.parseJson(StreamJsonMessage))

/**
 * Splits a string stream into lines and parses each as a StreamJsonMessage,
 * silently filtering out lines that don't match.
 * @since 1.0.0
 * @category parsers
 */
export const parseNdjsonMessages = flow(
  Stream.splitLines,
  Stream.filter((line: string) => line.trim().length > 0),
  Stream.mapEffect((line: string) =>
    decodeJsonMessage(line).pipe(
      Effect.tapError((err) =>
        Effect.logDebug("Non-JSON stdout line, skipping").pipe(
          Effect.annotateLogs({
            line: line.slice(0, 300),
            lineBytes: Array.from(line.slice(0, 100), (c) => c.charCodeAt(0).toString(16)).join(" "),
            error: err.message
          })
        )
      ),
      Effect.option
    )
  ),
  Stream.filterMap(identity)
)
