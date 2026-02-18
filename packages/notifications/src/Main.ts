/**
 * lalph-notify CLI entry point — zero-config notification service using lalph project config
 * @since 1.0.0
 */
import { Command as CliCommand, Options, Prompt } from "@effect/cli"
import { Command as PlatformCommand, FileSystem, Path } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Console, Effect, Layer, Logger, LogLevel, Option, Stream } from "effect"
import { AppContext, AppContextLive } from "./services/AppContext.js"
import { AppRuntimeConfig, RuntimeConfig } from "./services/AppRuntimeConfig.js"
import { MainLayer, runEventLoop } from "./services/EventLoop.js"
import { LalphConfig } from "./services/LalphConfig.js"
import { MessengerAdapter } from "./services/MessengerAdapter/MessengerAdapter.js"
import { PlanCommandBuilder } from "./services/PlanSession.js"
import { TelegramConfig, TelegramConfigLive, TelegramConfigSchema } from "./services/TelegramConfig.js"

const lalphNotifyCommand = CliCommand.make(
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

      const autoMergeEnabled = yield* Prompt.confirm({ message: "Enable auto-merge?", initial: false })
      const autoMergeWaitMinutes = autoMergeEnabled
        ? yield* Prompt.integer({ message: "Maximum minutes to wait after last push before merging", min: 1 })
        : null

      const runtimeConfig = new RuntimeConfig({
        pollIntervalSeconds: interval,
        triggerKeyword: keyword,
        timerDelaySeconds: timer,
        autoMergeEnabled,
        ...(autoMergeWaitMinutes !== null ? { autoMergeWaitMinutes } : {})
      })

      const planCommandLayer = Layer.effect(
        PlanCommandBuilder,
        Effect.gen(function*() {
          const appContext = yield* AppContext
          const fs = yield* FileSystem.FileSystem
          const pathService = yield* Path.Path

          // Resolve the real claude binary path
          const realClaudePath = yield* PlatformCommand.make("which", "claude").pipe(
            PlatformCommand.string,
            Effect.map((s) => s.trim())
          )
          yield* Effect.log("Resolved real claude path").pipe(
            Effect.annotateLogs({ realClaudePath })
          )

          // Create shim directory and script
          const shimDir = pathService.join(appContext.configDir, "bin")
          yield* fs.makeDirectory(shimDir, { recursive: true })

          const shimPath = pathService.join(shimDir, "claude")
          const shimScript = [
            "#!/bin/bash",
            `echo "claude-shim: intercepted call, adding --output-format stream-json, args: $*" >&2`,
            `exec ${JSON.stringify(realClaudePath)} --output-format stream-json "$@"`
          ].join("\n")
          yield* fs.writeFileString(shimPath, shimScript)
          yield* fs.chmod(shimPath, 0o755)
          yield* Effect.log("Claude shim created").pipe(
            Effect.annotateLogs({ shimPath })
          )

          const originalPath = process.env["PATH"] ?? ""
          const shimmedPath = `${shimDir}:${originalPath}`

          return (tempFile: string) =>
            PlatformCommand.make("lalph", "plan", "--file", tempFile, "--dangerous").pipe(
              PlatformCommand.workingDirectory(appContext.projectRoot),
              PlatformCommand.env({ PATH: shimmedPath }),
              PlatformCommand.stdout("pipe"),
              PlatformCommand.stderr("pipe"),
              PlatformCommand.stdin("pipe")
            )
        })
      )

      const appLayer = Layer.mergeAll(
        Layer.succeed(AppRuntimeConfig, runtimeConfig),
        Layer.succeed(TelegramConfig, store),
        planCommandLayer
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
).pipe(CliCommand.withDescription("Zero-config notification service using lalph project config"))

const cli = CliCommand.run(lalphNotifyCommand, {
  name: "lalph-notify",
  version: "1.0.0"
})

const logLevelLayer = Layer.unwrapEffect(
  Config.logLevel("LOG_LEVEL").pipe(
    Config.withDefault(LogLevel.Info),
    Effect.map(Logger.minimumLogLevel)
  )
)

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(TelegramConfigLive),
  Effect.provide(AppContextLive),
  Effect.provide(NodeContext.layer),
  Effect.provide(logLevelLayer),
  NodeRuntime.runMain
)
