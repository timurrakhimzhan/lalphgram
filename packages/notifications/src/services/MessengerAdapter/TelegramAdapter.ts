/**
 * Telegram messenger adapter using the Telegraf library
 * @since 1.0.0
 */
import { Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import { Markup, Telegraf } from "telegraf"
import { TelegramConfig } from "../TelegramConfig.js"
import {
  IncomingMessage,
  MessengerAdapter,
  MessengerAdapterError,
  type OutgoingMessage,
  type SentMessage
} from "./MessengerAdapter.js"

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

    const buttonLabels = new Map<string, string>()

    bot.action(/^q:(\d+):(\d+)$/, (ctx) => {
      const key = `${ctx.match[1]}:${ctx.match[2]}`
      const label = buttonLabels.get(key) ?? ctx.match[2] ?? ""
      buttonLabels.delete(key)
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
      Effect.try(() => {
        bot.stop("shutdown")
      }).pipe(Effect.ignore)
    )

    const resolveChatId = Effect.gen(function*() {
      const currentConfig = yield* store.get
      const chatId = Option.isSome(currentConfig) ? currentConfig.value.chatId : null
      if (chatId === null) {
        return yield* new MessengerAdapterError({
          message: "Telegram chat ID not configured. Run setup first.",
          cause: null
        })
      }
      return chatId
    })

    const toSentMessage = (result: { message_id: number }): SentMessage => ({
      id: String(result.message_id)
    })

    const sendMessage = (message: string | OutgoingMessage) =>
      Effect.gen(function*() {
        const resolvedChatId = yield* resolveChatId

        if (typeof message === "string") {
          const result = yield* Effect.tryPromise({
            try: () => bot.telegram.sendMessage(resolvedChatId, message, { parse_mode: "HTML" }),
            catch: (err) =>
              new MessengerAdapterError({
                message: `Failed to send Telegram message: ${String(err)}`,
                cause: err
              })
          })
          return toSentMessage(result)
        } else if (message.replyKeyboard != null && message.replyKeyboard.length > 0) {
          const replyMarkup = Markup.keyboard(
            message.replyKeyboard.map((o) => [Markup.button.text(o.label)])
          ).resize()

          const result = yield* Effect.tryPromise({
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
          return toSentMessage(result)
        } else {
          const qId = yield* Ref.updateAndGet(questionCounter, (n) => n + 1)
          const buttons = message.options?.map((o, i) => {
            buttonLabels.set(`${qId}:${i}`, o.label)
            return [Markup.button.callback(o.label, `q:${qId}:${i}`)]
          }) ?? []
          const keyboard = buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined

          const result = yield* Effect.tryPromise({
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
          return toSentMessage(result)
        }
      })

    const editMessage = (messageId: string, message: string | OutgoingMessage) =>
      Effect.gen(function*() {
        const resolvedChatId = yield* resolveChatId

        const text = typeof message === "string" ? message : message.text
        const inlineKeyboard = typeof message !== "string" && message.options != null && message.options.length > 0
          ? Markup.inlineKeyboard(
            message.options.map((o, i) => [Markup.button.callback(o.label, `e:${i}`)])
          )
          : { reply_markup: { inline_keyboard: [] } }

        yield* Effect.tryPromise({
          try: () =>
            bot.telegram.editMessageText(
              resolvedChatId,
              Number(messageId),
              undefined,
              text,
              { ...inlineKeyboard, parse_mode: "HTML" }
            ),
          catch: (err) =>
            new MessengerAdapterError({
              message: `Failed to edit Telegram message: ${String(err)}`,
              cause: err
            })
        })
      })

    const incomingMessages = Stream.fromQueue(messageQueue)

    return MessengerAdapter.of({ sendMessage, editMessage, incomingMessages })
  })
)
