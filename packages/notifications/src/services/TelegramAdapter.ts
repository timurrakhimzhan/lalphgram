/**
 * Telegram messenger adapter using the Telegraf library
 * @since 1.0.0
 */
import { Effect, Layer, Queue, Stream } from "effect"
import { Telegraf } from "telegraf"
import { AppCredentials } from "../schemas/CredentialSchemas.js"
import { IncomingMessage, MessengerAdapter, MessengerAdapterError } from "./MessengerAdapter.js"

/**
 * @since 1.0.0
 * @category layers
 */
export const TelegramAdapterLive = Layer.scoped(
  MessengerAdapter,
  Effect.gen(function*() {
    const creds = yield* AppCredentials
    const bot = new Telegraf(creds.telegramBotToken)
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
      Effect.tryPromise({
        try: () => bot.telegram.sendMessage(creds.telegramChatId, text, { parse_mode: "HTML" }),
        catch: (err) =>
          new MessengerAdapterError({
            message: `Failed to send Telegram message: ${String(err)}`,
            cause: err
          })
      }).pipe(Effect.asVoid)

    const incomingMessages = Stream.fromQueue(messageQueue)

    return MessengerAdapter.of({ sendMessage, incomingMessages })
  })
)
