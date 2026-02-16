/**
 * Telegram messenger adapter using the Telegraf library
 * @since 1.0.0
 */
import { Effect, Layer, Option, Queue, Stream } from "effect"
import { Telegraf } from "telegraf"
import { IncomingMessage, MessengerAdapter, MessengerAdapterError } from "./MessengerAdapter.js"
import { TelegramConfig } from "./TelegramConfig.js"

/**
 * @since 1.0.0
 * @category layers
 */
export const TelegramAdapterLive = Layer.scoped(
  MessengerAdapter,
  Effect.gen(function*() {
    const store = yield* TelegramConfig
    const config = yield* store.get

    if (Option.isNone(config) || config.value.botToken === "") {
      return yield* new MessengerAdapterError({
        message: "Telegram bot token not configured. Run setup first.",
        cause: null
      })
    }

    const bot = new Telegraf(config.value.botToken)
    const messageQueue = yield* Queue.unbounded<IncomingMessage>()

    bot.on("message", (ctx) => {
      const text = "text" in ctx.message ? ctx.message.text : undefined
      if (text != null && ctx.from != null) {
        const msg = new IncomingMessage({
          chatId: String(ctx.chat.id),
          text,
          from: ctx.from.username ?? ctx.from.first_name
        })
        Queue.unsafeOffer(messageQueue, msg)
      }
    })

    yield* Effect.tryPromise({
      try: () => bot.launch(),
      catch: (err) =>
        new MessengerAdapterError({
          message: `Failed to launch Telegram bot: ${String(err)}`,
          cause: err
        })
    }).pipe(Effect.fork)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        bot.stop("shutdown")
      })
    )

    const sendMessage = (text: string) =>
      Effect.gen(function*() {
        const currentConfig = yield* store.get
        const resolvedChatId = Option.isSome(currentConfig) ? currentConfig.value.chatId : null
        if (resolvedChatId === null) {
          return yield* new MessengerAdapterError({
            message: "Telegram chat ID not configured. Run setup first.",
            cause: null
          })
        }
        yield* Effect.tryPromise({
          try: () => bot.telegram.sendMessage(resolvedChatId, text, { parse_mode: "HTML" }),
          catch: (err) =>
            new MessengerAdapterError({
              message: `Failed to send Telegram message: ${String(err)}`,
              cause: err
            })
        })
      })

    const incomingMessages = Stream.fromQueue(messageQueue)

    return MessengerAdapter.of({ sendMessage, incomingMessages })
  })
)
