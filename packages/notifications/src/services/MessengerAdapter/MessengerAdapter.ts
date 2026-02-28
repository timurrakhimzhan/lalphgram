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
 * @category models
 */
export interface OutgoingMessage {
  readonly text: string
  readonly options?: ReadonlyArray<{ readonly label: string }> | undefined
  readonly replyKeyboard?: ReadonlyArray<{ readonly label: string }> | undefined
}

/**
 * @since 1.0.0
 * @category models
 */
export interface SentMessage {
  readonly id: string
}

/**
 * @since 1.0.0
 * @category services
 */
export interface MessengerAdapterService {
  readonly sendMessage: (message: string | OutgoingMessage) => Effect.Effect<SentMessage, MessengerAdapterError>
  readonly editMessage: (
    messageId: string,
    message: string | OutgoingMessage
  ) => Effect.Effect<void, MessengerAdapterError>
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
