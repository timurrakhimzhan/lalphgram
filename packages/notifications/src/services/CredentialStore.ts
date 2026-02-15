/**
 * CredentialStore service backed by KeyValueStore
 * @since 1.0.0
 */
import { KeyValueStore } from "@effect/platform"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { Credentials } from "../schemas/CredentialSchemas.js"

const CREDENTIALS_KEY = "credentials"

/**
 * @since 1.0.0
 * @category errors
 */
export class CredentialStoreError extends Data.TaggedError("CredentialStoreError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface CredentialStoreService {
  readonly get: Effect.Effect<Credentials, CredentialStoreError>
  readonly set: (credentials: Credentials) => Effect.Effect<void, CredentialStoreError>
  readonly has: Effect.Effect<boolean, CredentialStoreError>
  readonly clear: Effect.Effect<void, CredentialStoreError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class CredentialStore extends Context.Tag("CredentialStore")<
  CredentialStore,
  CredentialStoreService
>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const CredentialStoreLive = Layer.effect(
  CredentialStore,
  Effect.gen(function*() {
    const kv = yield* KeyValueStore.KeyValueStore
    const encode = Schema.encode(Schema.parseJson(Credentials))
    const decode = Schema.decode(Schema.parseJson(Credentials))

    const get = Effect.gen(function*() {
      const raw = yield* kv.get(CREDENTIALS_KEY)
      if (Option.isNone(raw)) {
        return yield* new CredentialStoreError({
          message: "No credentials stored",
          cause: null
        })
      }
      return yield* decode(raw.value)
    }).pipe(
      Effect.mapError((err) =>
        err instanceof CredentialStoreError
          ? err
          : new CredentialStoreError({
            message: `Failed to get credentials: ${String(err)}`,
            cause: err
          })
      )
    )

    const set = (credentials: Credentials) =>
      encode(credentials).pipe(
        Effect.flatMap((json) => kv.set(CREDENTIALS_KEY, json)),
        Effect.mapError((err) =>
          new CredentialStoreError({
            message: `Failed to set credentials: ${String(err)}`,
            cause: err
          })
        )
      )

    const has = kv.has(CREDENTIALS_KEY).pipe(
      Effect.mapError((err) =>
        new CredentialStoreError({
          message: `Failed to check credentials: ${String(err)}`,
          cause: err
        })
      )
    )

    const clear = kv.remove(CREDENTIALS_KEY).pipe(
      Effect.mapError((err) =>
        new CredentialStoreError({
          message: `Failed to clear credentials: ${String(err)}`,
          cause: err
        })
      )
    )

    return CredentialStore.of({ get, set, has, clear })
  })
)
