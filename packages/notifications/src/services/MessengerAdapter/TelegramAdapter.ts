/**
 * Telegram messenger adapter using the Telegraf library
 * @since 1.0.0
 */
import { Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import { Markup, Telegraf } from "telegraf"
import { TelegramConfig } from "../TelegramConfig.js"
import { IncomingMessage, MessengerAdapter, MessengerAdapterError, type OutgoingMessage } from "./MessengerAdapter.js"

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
    const questionCounter = yield* Ref.make(0)

    bot.action(/^q:(\d+):(.+)$/, (ctx) => {
      const label = ctx.match[2] ?? ""
      if (ctx.from != null) {
        const msg = new IncomingMessage({
          chatId: String(ctx.chat?.id ?? ""),
          text: label,
          from: ctx.from.username ?? ctx.from.first_name
        })
        Queue.unsafeOffer(messageQueue, msg)
      }
      Effect.runPromise(
        Effect.tryPromise({
          try: () => ctx.editMessageText(`${label} ✓`),
          catch: () => new MessengerAdapterError({ message: "Failed to edit message", cause: null })
        }).pipe(Effect.orElseSucceed(() => undefined))
      )
      return ctx.answerCbQuery()
    })

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

    const sendMessage = (message: string | OutgoingMessage) =>
      Effect.gen(function*() {
        const currentConfig = yield* store.get
        const resolvedChatId = Option.isSome(currentConfig) ? currentConfig.value.chatId : null
        if (resolvedChatId === null) {
          return yield* new MessengerAdapterError({
            message: "Telegram chat ID not configured. Run setup first.",
            cause: null
          })
        }

        if (typeof message === "string") {
          yield* Effect.tryPromise({
            try: () => bot.telegram.sendMessage(resolvedChatId, message, { parse_mode: "HTML" }),
            catch: (err) =>
              new MessengerAdapterError({
                message: `Failed to send Telegram message: ${String(err)}`,
                cause: err
              })
          })
        } else if (message.replyKeyboard != null && message.replyKeyboard.length > 0) {
          const replyMarkup = Markup.keyboard(
            message.replyKeyboard.map((o) => [Markup.button.text(o.label)])
          ).resize()

          yield* Effect.tryPromise({
            try: () =>
              bot.telegram.sendMessage(resolvedChatId, message.text, {
                ...replyMarkup,
                parse_mode: "HTML"
              }),
            catch: (err) =>
              new MessengerAdapterError({
                message: `Failed to send Telegram message: ${String(err)}`,
                cause: err
              })
          })
        } else {
          const qId = yield* Ref.updateAndGet(questionCounter, (n) => n + 1)
          const buttons = message.options?.map((o) => [
            Markup.button.callback(o.label, `q:${qId}:${o.label}`)
          ]) ?? []
          const keyboard = buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined

          yield* Effect.tryPromise({
            try: () =>
              bot.telegram.sendMessage(resolvedChatId, message.text, {
                ...keyboard,
                parse_mode: "HTML"
              }),
            catch: (err) =>
              new MessengerAdapterError({
                message: `Failed to send Telegram message: ${String(err)}`,
                cause: err
              })
          })
        }
      })

    const incomingMessages = Stream.fromQueue(messageQueue)

    return MessengerAdapter.of({ sendMessage, incomingMessages })
  })
)
