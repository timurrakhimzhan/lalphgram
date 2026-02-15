/**
 * Generic messenger adapter interface for sending and receiving messages
 * @since 1.0.0
 */
import type { Effect, Stream } from "effect"
import { Context, Data, Schema } from "effect"

/**
 * @since 1.0.0
 * @category errors
 */
export class MessengerAdapterError extends Data.TaggedError("MessengerAdapterError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class IncomingMessage extends Schema.Class<IncomingMessage>("IncomingMessage")({
  chatId: Schema.String,
  text: Schema.String,
  from: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category services
 */
export interface MessengerAdapterService {
  readonly sendMessage: (text: string) => Effect.Effect<void, MessengerAdapterError>
  readonly incomingMessages: Stream.Stream<IncomingMessage, MessengerAdapterError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class MessengerAdapter extends Context.Tag("MessengerAdapter")<
  MessengerAdapter,
  MessengerAdapterService
>() {}
