/**
 * Linear SDK client service
 * @since 1.0.0
 */
import { LinearClient } from "@linear/sdk"
import { Context, Data, Effect, Layer } from "effect"
import { LalphConfig } from "./LalphConfig.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class LinearSdkClientError extends Data.TaggedError("LinearSdkClientError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category models
 */
export interface LinearSdkIssue {
  readonly id: string
  readonly identifier: string
  readonly title: string
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly stateName: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface LinearSdkWorkflowState {
  readonly id: string
  readonly name: string
  readonly type: string
}

/**
 * @since 1.0.0
 * @category services
 */
export interface LinearSdkClientService {
  readonly listIssues: (params: {
    readonly since: string
    readonly projectIds?: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyArray<LinearSdkIssue>, LinearSdkClientError>
  readonly getIssue: (params: {
    readonly id: string
  }) => Effect.Effect<LinearSdkIssue, LinearSdkClientError>
  readonly listWorkflowStates: () => Effect.Effect<ReadonlyArray<LinearSdkWorkflowState>, LinearSdkClientError>
  readonly updateIssue: (params: {
    readonly id: string
    readonly stateId: string
  }) => Effect.Effect<void, LinearSdkClientError>
  readonly updateIssuePriority: (params: {
    readonly id: string
    readonly priority: number
  }) => Effect.Effect<void, LinearSdkClientError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class LinearSdkClient extends Context.Tag("LinearSdkClient")<LinearSdkClient, LinearSdkClientService>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const LinearSdkClientLive = Layer.effect(
  LinearSdkClient,
  Effect.gen(function*() {
    const watcher = yield* LalphConfig
    const initialToken = yield* watcher.linearToken.pipe(
      Effect.mapError((err) => new LinearSdkClientError({ message: err.message, cause: err }))
    )

    let currentToken = initialToken
    let client = new LinearClient({ accessToken: currentToken })

    const getClient = Effect.gen(function*() {
      const latestToken = yield* watcher.linearToken.pipe(
        Effect.mapError((err) => new LinearSdkClientError({ message: err.message, cause: err }))
      )
      if (latestToken !== currentToken) {
        currentToken = latestToken
        client = new LinearClient({ accessToken: latestToken })
      }
      return client
    })

    return LinearSdkClient.of({
      listIssues: (params) =>
        Effect.gen(function*() {
          const c = yield* getClient
          return yield* Effect.tryPromise({
            try: async () => {
              const filter: Record<string, unknown> = { updatedAt: { gte: new Date(params.since) } }
              if (params.projectIds && params.projectIds.length > 0) {
                filter.project = { id: { in: params.projectIds } }
              }
              const connection = await c.issues({ filter })
              const results: Array<LinearSdkIssue> = []
              for (const node of connection.nodes) {
                const state = await node.state
                results.push({
                  id: node.id,
                  identifier: node.identifier,
                  title: node.title,
                  url: node.url,
                  createdAt: node.createdAt.toISOString(),
                  updatedAt: node.updatedAt.toISOString(),
                  stateName: state?.name ?? "Unknown"
                })
              }
              return results
            },
            catch: (err) => new LinearSdkClientError({ message: `Failed to list issues: ${String(err)}`, cause: err })
          })
        }),

      getIssue: (params) =>
        Effect.gen(function*() {
          const c = yield* getClient
          return yield* Effect.tryPromise({
            try: async () => {
              const node = await c.issue(params.id)
              const state = await node.state
              return {
                id: node.id,
                identifier: node.identifier,
                title: node.title,
                url: node.url,
                createdAt: node.createdAt.toISOString(),
                updatedAt: node.updatedAt.toISOString(),
                stateName: state?.name ?? "Unknown"
              }
            },
            catch: (err) => new LinearSdkClientError({ message: `Failed to get issue: ${String(err)}`, cause: err })
          })
        }),

      listWorkflowStates: () =>
        Effect.gen(function*() {
          const c = yield* getClient
          return yield* Effect.tryPromise({
            try: () => c.workflowStates(),
            catch: (err) =>
              new LinearSdkClientError({ message: `Failed to list workflow states: ${String(err)}`, cause: err })
          }).pipe(
            Effect.map((connection) =>
              connection.nodes.map((node): LinearSdkWorkflowState => ({
                id: node.id,
                name: node.name,
                type: node.type
              }))
            )
          )
        }),

      updateIssue: (params) =>
        Effect.gen(function*() {
          const c = yield* getClient
          return yield* Effect.tryPromise({
            try: () => c.updateIssue(params.id, { stateId: params.stateId }),
            catch: (err) => new LinearSdkClientError({ message: `Failed to update issue: ${String(err)}`, cause: err })
          }).pipe(Effect.asVoid)
        }),

      updateIssuePriority: (params) =>
        Effect.gen(function*() {
          const c = yield* getClient
          return yield* Effect.tryPromise({
            try: () => c.updateIssue(params.id, { priority: params.priority }),
            catch: (err) =>
              new LinearSdkClientError({ message: `Failed to update issue priority: ${String(err)}`, cause: err })
          }).pipe(Effect.asVoid)
        })
    })
  })
)
