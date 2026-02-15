/**
 * CLI commands and main event loop
 * @since 1.0.0
 */
import { Command, Options, Prompt } from "@effect/cli"
import { NodeContext, NodeKeyValueStore, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer, Match, Stream } from "effect"
import { Octokit } from "octokit"
import { Telegraf } from "telegraf"
import type { AppEvent } from "./Events.js"
import { AppCredentials, AppRuntimeConfig, Credentials, RuntimeConfig } from "./schemas/CredentialSchemas.js"
import { GitHubRepo } from "./schemas/GitHubSchemas.js"
import { CommentTimer, CommentTimerLive } from "./services/CommentTimer.js"
import { CredentialStore, CredentialStoreLive } from "./services/CredentialStore.js"
import { GitHubClient, GitHubClientLive } from "./services/GitHubClient.js"
import { GitHubEventSource, GitHubEventSourceLive } from "./services/GitHubEventSource.js"
import { GitHubIssueTrackerLive } from "./services/GitHubIssueTracker.js"
import { LinearSdkClientLive } from "./services/LinearSdkClient.js"
import { LinearTrackerLive } from "./services/LinearTracker.js"
import { MessengerAdapter } from "./services/MessengerAdapter.js"
import { OctokitClientLive } from "./services/OctokitClient.js"
import { TaskEventSource, TaskEventSourceLive } from "./services/TaskEventSource.js"
import { TaskTracker } from "./services/TaskTracker.js"
import { TelegramAdapterLive } from "./services/TelegramAdapter.js"

const fetchUserRepos = (token: string) =>
  Effect.tryPromise({
    try: async () => {
      const octokit = new Octokit({ auth: token })
      const response = await octokit.rest.repos.listForAuthenticatedUser({
        per_page: 100,
        type: "owner"
      })
      return response.data.map((r) =>
        new GitHubRepo({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: { login: r.owner.login },
          html_url: r.html_url
        })
      )
    },
    catch: (err) => new Error(`Failed to fetch repos: ${String(err)}`)
  })

const promptWatchedRepos = (token: string) =>
  Effect.gen(function*() {
    const repos = yield* fetchUserRepos(token).pipe(
      Effect.tapError((err) => Effect.logWarning(`Failed to fetch repos: ${String(err)}. Defaulting to watch all.`)),
      Effect.orElseSucceed((): ReadonlyArray<GitHubRepo> => [])
    )

    if (repos.length === 0) {
      return [] as const
    }

    const watchAll = yield* Prompt.confirm({
      message: `Found ${repos.length} repos. Watch all?`
    })

    if (watchAll) {
      return [] as const
    }

    const selected = yield* Prompt.multiSelect({
      message: "Select repos to watch",
      choices: repos.map((repo) => ({ title: repo.full_name, value: repo.full_name }))
    })

    return selected
  })

const fetchTelegramChatId = (botToken: string) =>
  Effect.tryPromise({
    try: async () => {
      const bot = new Telegraf(botToken)
      const updates = await bot.telegram.getUpdates(0, 100, 0, [])
      const withMessages = updates.filter((u) => "message" in u)
      const lastUpdate = withMessages[withMessages.length - 1]
      if (!lastUpdate || !("message" in lastUpdate)) {
        throw new Error("No messages found. Did you send a message to the bot?")
      }
      return String(lastUpdate.message.chat.id)
    },
    catch: (err) => new Error(`Failed to detect chat ID: ${String(err)}`)
  })

const promptTelegramChatId = (botToken: string) =>
  Effect.gen(function*() {
    yield* Prompt.text({
      message: "Send a message to your Telegram bot, then press Enter"
    })
    const chatId = yield* fetchTelegramChatId(botToken).pipe(
      Effect.tapError((err) => Effect.logWarning(`Failed to detect chat ID: ${String(err)}`)),
      Effect.orElse(() => Prompt.text({ message: "Could not detect chat ID automatically. Enter it manually" }))
    )
    return chatId
  })

const promptCredentials = Effect.gen(function*() {
  const backend = yield* Prompt.select({
    message: "Select task tracker backend",
    choices: [
      { title: "GitHub Issues", value: "github" as const },
      { title: "Linear", value: "linear" as const }
    ]
  })

  const linearApiKey = backend === "linear"
    ? yield* Prompt.text({ message: "Linear API key" })
    : ""

  const githubToken = yield* Prompt.text({
    message: "GitHub personal access token (used for PR monitoring)"
  })

  const watchedRepos = yield* promptWatchedRepos(githubToken)

  const telegramBotToken = yield* Prompt.text({
    message: "Telegram bot token"
  })

  const telegramChatId = yield* promptTelegramChatId(telegramBotToken)

  return new Credentials({
    backend,
    githubToken,
    telegramBotToken,
    telegramChatId,
    linearApiKey,
    watchedRepos: [...watchedRepos]
  })
})

/**
 * Load credentials from store, or prompt and save if missing.
 * @since 1.0.0
 * @category cli
 */
export const ensureCredentials = Effect.gen(function*() {
  const store = yield* CredentialStore
  const hasExisting = yield* store.has

  if (hasExisting) {
    return yield* store.get
  }

  const creds = yield* promptCredentials
  yield* store.set(creds)
  yield* Console.log("Credentials saved successfully.")
  return creds
})

/**
 * Config command — configure credentials interactively
 * @since 1.0.0
 * @category cli
 */
export const configCommand = Command.make(
  "config",
  { reset: Options.boolean("reset").pipe(Options.withDefault(false)) },
  ({ reset }) =>
    Effect.gen(function*() {
      const store = yield* CredentialStore

      if (reset) {
        yield* store.clear
        yield* Console.log("Credentials cleared.")
      }

      const creds = yield* promptCredentials
      yield* store.set(creds)
      yield* Console.log("Credentials saved successfully.")
    })
).pipe(Command.withDescription("Configure notification credentials"))

/**
 * Build the main layer for the event loop based on credentials and runtime config.
 * @since 1.0.0
 * @category layers
 */
export const makeMainLayer = (creds: Credentials, runtimeConfig: RuntimeConfig) => {
  const trackerLayer = creds.backend === "linear"
    ? LinearTrackerLive
    : GitHubIssueTrackerLive

  const appLayer = Layer.mergeAll(
    Layer.succeed(AppCredentials, creds),
    Layer.succeed(AppRuntimeConfig, runtimeConfig)
  )

  const octokitLayer = OctokitClientLive.pipe(
    Layer.provide(appLayer)
  )

  const linearSdkLayer = LinearSdkClientLive.pipe(
    Layer.provide(appLayer)
  )

  const telegramAdapterLayer = TelegramAdapterLive.pipe(
    Layer.provide(appLayer)
  )

  const servicesLayer = Layer.mergeAll(
    GitHubClientLive,
    telegramAdapterLayer,
    trackerLayer
  ).pipe(
    Layer.provide(octokitLayer),
    Layer.provide(linearSdkLayer),
    Layer.provide(appLayer)
  )

  const eventSourcesLayer = Layer.mergeAll(
    GitHubEventSourceLive,
    TaskEventSourceLive
  ).pipe(
    Layer.provide(servicesLayer),
    Layer.provide(appLayer)
  )

  const commentTimerLayer = CommentTimerLive.pipe(
    Layer.provide(servicesLayer),
    Layer.provide(appLayer)
  )

  return Layer.mergeAll(
    servicesLayer,
    eventSourcesLayer,
    commentTimerLayer,
    appLayer
  )
}

/**
 * Start command — run the event loop
 * @since 1.0.0
 * @category cli
 */
export const startCommand = Command.make(
  "start",
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
      const creds = yield* ensureCredentials

      const runtimeConfig = new RuntimeConfig({
        pollIntervalSeconds: interval,
        triggerKeyword: keyword,
        timerDelaySeconds: timer
      })

      yield* runEventLoop.pipe(
        Effect.provide(makeMainLayer(creds, runtimeConfig))
      )
    })
).pipe(Command.withDescription("Start the notification event loop"))

/**
 * The main event loop that merges all event streams and dispatches events
 * @since 1.0.0
 * @category event-loop
 */
export const runEventLoop = Effect.gen(function*() {
  const githubEvents = yield* GitHubEventSource
  const taskEvents = yield* TaskEventSource
  const notifier = yield* MessengerAdapter
  const github = yield* GitHubClient
  const timer = yield* CommentTimer
  const tracker = yield* TaskTracker

  const dispatchEvent = (event: AppEvent) =>
    Match.value(event).pipe(
      Match.tag("TaskCreated", (e) =>
        notifier.sendMessage(`📋 <b>New task created</b>\n<a href="${e.issue.url}">${e.issue.title}</a>`)),
      Match.tag("TaskUpdated", (e) =>
        notifier.sendMessage(
          `✏️ <b>Task moved to ${e.issue.state}</b>\n<a href="${e.issue.url}">${e.issue.title}</a>\n${e.previousState} → ${e.issue.state}`
        )),
      Match.tag("PROpened", (e) =>
        notifier.sendMessage(`🔀 <b>New PR opened</b>\n<a href="${e.pr.html_url}">${e.pr.title}</a>`)),
      Match.tag("PRConflictDetected", (e) =>
        Effect.gen(function*() {
          yield* github.postComment(
            new GitHubRepo({
              id: 0,
              name: "",
              full_name: e.pr.repo,
              owner: { login: "" },
              html_url: ""
            }),
            e.pr.number,
            "This PR has merge conflicts that need to be resolved."
          )
          const issueId = e.pr.headRef
          yield* tracker.moveToTodo(issueId).pipe(
            Effect.tapError((err) =>
              Effect.logError(`Failed to move to todo: ${err.message}`)
            ),
            Effect.orElseSucceed(() =>
              undefined
            )
          )
          yield* tracker.setPriorityUrgent(issueId).pipe(
            Effect.tapError((err) => Effect.logError(`Failed to set priority: ${err.message}`)),
            Effect.orElseSucceed(() => undefined)
          )
          yield* notifier.sendMessage(
            `⚠️ <b>Conflict detected</b>\n<a href="${e.pr.html_url}">${e.pr.title}</a>`
          )
        })),
      Match.tag("PRCommentAdded", (e) =>
        timer.handleComment(e.pr, e.comment).pipe(
          Effect.tapError((err) => Effect.logError(`Comment timer error: ${err.message}`)),
          Effect.orElseSucceed(() => undefined)
        )),
      Match.exhaustive
    )

  const mergedStream = Stream.merge(
    githubEvents.stream,
    taskEvents.stream
  )

  yield* Console.log("Notification service started. Press Ctrl+C to stop.")

  yield* mergedStream.pipe(
    Stream.runForEach((event) =>
      dispatchEvent(event).pipe(
        Effect.catchAll((err) => Effect.logError(`Event dispatch error: ${String(err)}`))
      )
    ),
    Effect.ensuring(
      timer.shutdown.pipe(
        Effect.tapError((err) => Effect.logError(`Shutdown error: ${err.message}`)),
        Effect.orElseSucceed(() => undefined)
      )
    ),
    Effect.annotateLogs("service", "Main"),
    Effect.catchAll((err) => Effect.logError(`Event loop error: ${String(err)}`))
  )
})

/**
 * Root command with subcommands
 * @since 1.0.0
 * @category cli
 */
export const notifyCommand = Command.make("notify").pipe(
  Command.withDescription("GitHub & task tracker notification service"),
  Command.withSubcommands([configCommand, startCommand])
)

/**
 * CLI runner
 * @since 1.0.0
 * @category cli
 */
export const cli = Command.run(notifyCommand, {
  name: "notify",
  version: "1.0.0"
})

const credentialStoreLayer = CredentialStoreLive.pipe(
  Layer.provide(NodeKeyValueStore.layerFileSystem("~/.notify-config"))
)

/**
 * Main entry point
 * @since 1.0.0
 * @category main
 */
export const main = Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(credentialStoreLayer),
  Effect.provide(NodeContext.layer)
)

// Run the CLI
NodeRuntime.runMain(main)
