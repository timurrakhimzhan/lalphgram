/**
 * Service for uploading spec HTML files to a hosting backend.
 * Two implementations: GitHub Gist and Telegraph (default).
 * @since 1.0.0
 */
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Context, Data, Effect, Layer, Schema } from "effect"
import * as Crypto from "node:crypto"
import { toTelegraphHtml } from "../lib/TelegraphHtml.js"
import { OctokitClient } from "./OctokitClient.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class SpecUploaderError extends Data.TaggedError("SpecUploaderError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface SpecUploaderService {
  readonly upload: (html: string, description: string) => Effect.Effect<{ readonly url: string }, SpecUploaderError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class SpecUploader extends Context.Tag("SpecUploader")<SpecUploader, SpecUploaderService>() {}

/**
 * GitHub Gist implementation — wraps existing OctokitClient.createGist.
 * @since 1.0.0
 * @category layers
 */
export const GistSpecUploaderLive = Layer.effect(
  SpecUploader,
  Effect.gen(function*() {
    const octokitClient = yield* OctokitClient

    return SpecUploader.of({
      upload: (html, description) =>
        Effect.gen(function*() {
          const gist = yield* octokitClient.createGist({
            description,
            files: { "spec.html": { content: html } },
            isPublic: false
          }).pipe(
            Effect.mapError((err) =>
              new SpecUploaderError({
                message: `Gist upload failed: ${err.message}`,
                cause: err
              })
            )
          )

          const rawUrl = gist.files["spec.html"]?.rawUrl ?? gist.htmlUrl
          const viewUrl = `https://htmlpreview.github.io/?${rawUrl}`
          return { url: viewUrl }
        })
    })
  })
)

const TelegraphSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})

const TelegraphError = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String
})

const TelegraphResponse = Schema.Union(TelegraphSuccess, TelegraphError)

/**
 * Telegraph implementation — creates anonymous account, uploads pages via Telegraph API.
 * No account or tokens required. Requires HttpClient.
 * @since 1.0.0
 * @category layers
 */
export const TelegraphSpecUploaderLive = Layer.effect(
  SpecUploader,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient

    const telegraphPost = (url: string, body: Record<string, unknown>, label: string) => {
      const req = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyUnsafeJson(body)
      )
      return client.execute(req).pipe(
        Effect.flatMap((res) => res.json),
        Effect.scoped,
        Effect.flatMap(Schema.decodeUnknown(TelegraphResponse)),
        Effect.flatMap((parsed) =>
          parsed.ok
            ? Effect.succeed(parsed.result)
            : Effect.fail(
              new SpecUploaderError({
                message: `Telegraph ${label} failed: ${parsed.error}`,
                cause: null
              })
            )
        ),
        Effect.mapError((err) =>
          err instanceof SpecUploaderError
            ? err
            : new SpecUploaderError({
              message: `Telegraph ${label} request failed: ${String(err)}`,
              cause: err
            })
        )
      )
    }

    const accountResult = yield* telegraphPost(
      "https://api.telegra.ph/createAccount",
      { short_name: "lalph" },
      "createAccount"
    )

    const accessToken = String(accountResult.access_token)

    return SpecUploader.of({
      upload: (html, description) =>
        Effect.gen(function*() {
          const telegraphHtml = toTelegraphHtml(html)
          const title = Crypto.randomUUID()

          const pageResult = yield* telegraphPost(
            "https://api.telegra.ph/createPage",
            {
              access_token: accessToken,
              title,
              author_name: "lalph",
              content: telegraphHtml,
              return_content: false
            },
            "createPage"
          )

          return { url: String(pageResult.url) }
        }).pipe(Effect.annotateLogs("description", description))
    })
  })
)
