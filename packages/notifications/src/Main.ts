/**
 * lalph-notify CLI entry point — zero-config notification service using lalph project config
 * @since 1.0.0
 */
import { Command, Options, Prompt } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer, Option, Stream } from "effect"
import { AppRuntimeConfig, RuntimeConfig } from "./schemas/CredentialSchemas.js"
import { AppContextLive } from "./services/AppContext.js"
import { MainLayer, runEventLoop } from "./services/EventLoop.js"
import { LalphConfig } from "./services/LalphConfig.js"
import { MessengerAdapter } from "./services/MessengerAdapter.js"
import { TelegramConfig, TelegramConfigLive, TelegramConfigSchema } from "./services/TelegramConfig.js"

const lalphNotifyCommand = Command.make(
  "lalph-notify",
  {
    interval: Options.integer("interval").pipe(
      Options.withDefault(30),
      Options.withDescription("Poll interval in seconds")
    ),
    keyword: Options.text("keyword").pipe(
      Options.withDefault("urgent"),
      Options.withDescription("Trigger keyword for comment timer")
    ),
    timer: Options.integer("timer").pipe(
      Options.withDefault(300),
      Options.withDescription("Comment timer delay in seconds")
    )
  },
  ({ interval, keyword, timer }) =>
    Effect.gen(function*() {
      const store = yield* TelegramConfig

      const existingTelegram = yield* store.get
      const botToken = Option.isSome(existingTelegram)
        ? existingTelegram.value.botToken
        : yield* Prompt.text({ message: "Telegram bot token" })
      const storedChatId = Option.isSome(existingTelegram)
        ? existingTelegram.value.chatId
        : null

      if (Option.isNone(existingTelegram)) {
        yield* store.set(new TelegramConfigSchema({ botToken, chatId: null }))
      }

      const runtimeConfig = new RuntimeConfig({
        pollIntervalSeconds: interval,
        triggerKeyword: keyword,
        timerDelaySeconds: timer
      })

      const appLayer = Layer.mergeAll(
        Layer.succeed(AppRuntimeConfig, runtimeConfig),
        Layer.succeed(TelegramConfig, store)
      )

      yield* Effect.gen(function*() {
        const creds = yield* LalphConfig
        yield* Console.log(`Issue source: ${creds.issueSource}, repo: ${creds.repoFullName}`)

        if (storedChatId === null) {
          const messenger = yield* MessengerAdapter
          yield* Console.log("Send any message to your Telegram bot to continue...")
          const messages = yield* messenger.incomingMessages.pipe(
            Stream.take(1),
            Stream.runCollect
          )
          const firstMsg = [...messages][0]!
          yield* store.set(new TelegramConfigSchema({ botToken, chatId: firstMsg.chatId }))
          yield* Console.log("Telegram config saved.")
        }

        yield* runEventLoop
      }).pipe(
        Effect.provide(MainLayer.pipe(Layer.provide(appLayer)))
      )
    })
).pipe(Command.withDescription("Zero-config notification service using lalph project config"))

const cli = Command.run(lalphNotifyCommand, {
  name: "lalph-notify",
  version: "1.0.0"
})

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(TelegramConfigLive),
  Effect.provide(AppContextLive),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
