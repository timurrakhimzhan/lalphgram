/**
 * Provides current GitHub and Linear tokens, refreshing from .lalph/config/ file changes
 * @since 1.0.0
 */
import { Command, FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Layer, Ref, Schema, Stream } from "effect"
import { LalphGithubToken, LalphLinearToken } from "../schemas/CredentialSchemas.js"
import { AppContext } from "./AppContext.js"

/**
 * Parse owner/repo from SSH or HTTPS git URL
 */
const parseRepoFullName = (url: string): string => {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined) {
    return sshMatch[1]
  }
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch?.[1] !== undefined) {
    return httpsMatch[1]
  }
  return url
}

/**
 * @since 1.0.0
 * @category errors
 */
export class LalphConfigError extends Data.TaggedError("LalphConfigError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface LalphConfigService {
  readonly githubToken: Effect.Effect<string, LalphConfigError>
  readonly linearToken: Effect.Effect<string, LalphConfigError>
  readonly issueSource: "linear" | "github"
  readonly specUploader: "gist" | "telegraph"
  readonly repoFullName: string
}

/**
 * @since 1.0.0
 * @category context
 */
export class LalphConfig extends Context.Tag("lalph-notifier/services/LalphConfig")<
  LalphConfig,
  LalphConfigService
>() {}

const githubTokenFileName = encodeURIComponent("github.accessToken")
const linearTokenFileName = encodeURIComponent("linear.accessToken")

/**
 * @since 1.0.0
 * @category layers
 */
export const LalphConfigLive = Layer.scoped(
  LalphConfig,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const appContext = yield* AppContext

    const configDir = appContext.configDir

    const readFile = <A extends { token: string }, I>(key: string, schema: Schema.Schema<A, I>) =>
      Effect.gen(function*() {
        const filePath = pathService.join(configDir, encodeURIComponent(key))
        const content = yield* fs.readFileString(filePath).pipe(
          Effect.mapError((err) =>
            new LalphConfigError({
              message: `Failed to read config file: ${key}`,
              cause: err
            })
          )
        )
        const json = yield* Effect.try({
          try: () => JSON.parse(content),
          catch: (err) =>
            new LalphConfigError({
              message: `Failed to parse JSON in config file: ${key}`,
              cause: err
            })
        })
        return yield* Schema.decodeUnknown(schema)(json).pipe(
          Effect.mapError((err) =>
            new LalphConfigError({
              message: `Failed to decode config file: ${key}`,
              cause: err
            })
          )
        )
      })

    const readStringFile = (key: string) =>
      Effect.gen(function*() {
        const filePath = pathService.join(configDir, encodeURIComponent(key))
        const content = yield* fs.readFileString(filePath).pipe(
          Effect.mapError((err) =>
            new LalphConfigError({
              message: `Failed to read config file: ${key}`,
              cause: err
            })
          )
        )
        return yield* Effect.try({
          try: () => JSON.parse(content),
          catch: (err) =>
            new LalphConfigError({
              message: `Failed to parse JSON in config file: ${key}`,
              cause: err
            })
        })
      }).pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.String)),
        Effect.mapError((err) =>
          new LalphConfigError({
            message: `Failed to decode config file: ${key}`,
            cause: err
          })
        )
      )

    const githubTokenData = yield* readFile("github.accessToken", LalphGithubToken)
    const issueSourceRaw = yield* readStringFile("settings.issueSource")
    const issueSource = issueSourceRaw === "linear" ? "linear" as const : "github" as const

    const specUploaderRaw = yield* readStringFile("settings.specUploader").pipe(
      Effect.orElseSucceed(() => "telegraph")
    )
    const specUploader = specUploaderRaw === "gist"
      ? "gist" as const
      : "telegraph" as const

    const linearAccessToken = issueSource === "linear"
      ? yield* readFile("linear.accessToken", LalphLinearToken).pipe(
        Effect.map((t) => t.token)
      )
      : ""

    const repoFullName = yield* Effect.gen(function*() {
      const cmd = Command.make("git", "remote", "get-url", "origin").pipe(
        Command.workingDirectory(appContext.projectRoot)
      )
      const output = yield* Command.string(cmd).pipe(
        Effect.mapError((err) =>
          new LalphConfigError({
            message: "Failed to detect git remote origin URL",
            cause: err
          })
        )
      )
      return parseRepoFullName(output.trim())
    })

    const githubTokenRef = yield* Ref.make(githubTokenData.token)
    const linearTokenRef = yield* Ref.make(linearAccessToken)

    const readAndDecodeToken = <A extends { token: string }, I>(
      fileName: string,
      schema: Schema.Schema<A, I>
    ) =>
      Effect.gen(function*() {
        const filePath = pathService.join(configDir, fileName)
        const content = yield* fs.readFileString(filePath)
        const json = yield* Effect.try({
          try: () => JSON.parse(content),
          catch: (err) => err
        })
        return yield* Schema.decodeUnknown(schema)(json)
      })

    yield* fs.watch(configDir).pipe(
      Stream.filter((event) => event._tag === "Update"),
      Stream.mapEffect((event) => {
        const fileName = pathService.basename(event.path)
        if (fileName === githubTokenFileName) {
          return readAndDecodeToken(githubTokenFileName, LalphGithubToken).pipe(
            Effect.flatMap((decoded) => Ref.set(githubTokenRef, decoded.token)),
            Effect.tapError((err) => Effect.logWarning(`Failed to refresh GitHub token from file: ${String(err)}`)),
            Effect.orElseSucceed(() => undefined)
          )
        }
        if (fileName === linearTokenFileName) {
          return readAndDecodeToken(linearTokenFileName, LalphLinearToken).pipe(
            Effect.flatMap((decoded) => Ref.set(linearTokenRef, decoded.token)),
            Effect.tapError((err) => Effect.logWarning(`Failed to refresh Linear token from file: ${String(err)}`)),
            Effect.orElseSucceed(() => undefined)
          )
        }
        return Effect.void
      }),
      Stream.runDrain,
      Effect.annotateLogs("service", "LalphConfig"),
      Effect.catchAll((err) => Effect.logError(`Credential watcher stream ended: ${String(err)}`)),
      Effect.forkScoped
    )

    return LalphConfig.of({
      githubToken: Ref.get(githubTokenRef).pipe(
        Effect.mapError((cause) => new LalphConfigError({ message: "Failed to get GitHub token", cause }))
      ),
      linearToken: Ref.get(linearTokenRef).pipe(
        Effect.mapError((cause) => new LalphConfigError({ message: "Failed to get Linear token", cause }))
      ),
      issueSource,
      specUploader,
      repoFullName
    })
  })
)
