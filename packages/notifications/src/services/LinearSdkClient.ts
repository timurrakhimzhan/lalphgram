/**
 * Linear SDK client service
 * @since 1.0.0
 */
import { LinearClient } from "@linear/sdk"
import { Context, Data, Effect, Layer } from "effect"
import { AppCredentials } from "../schemas/CredentialSchemas.js"

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
    const creds = yield* AppCredentials
    const client = new LinearClient({ apiKey: creds.linearApiKey })

    const listIssues = (params: { readonly since: string }) =>
      Effect.tryPromise({
        try: async () => {
          const connection = await client.issues({ filter: { updatedAt: { gte: new Date(params.since) } } })
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

    const getIssue = (params: { readonly id: string }) =>
      Effect.tryPromise({
        try: async () => {
          const node = await client.issue(params.id)
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

    const listWorkflowStates = () =>
      Effect.tryPromise({
        try: () => client.workflowStates(),
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

    const updateIssue = (params: { readonly id: string; readonly stateId: string }) =>
      Effect.tryPromise({
        try: () => client.updateIssue(params.id, { stateId: params.stateId }),
        catch: (err) => new LinearSdkClientError({ message: `Failed to update issue: ${String(err)}`, cause: err })
      }).pipe(Effect.asVoid)

    const updateIssuePriority = (params: { readonly id: string; readonly priority: number }) =>
      Effect.tryPromise({
        try: () => client.updateIssue(params.id, { priority: params.priority }),
        catch: (err) =>
          new LinearSdkClientError({ message: `Failed to update issue priority: ${String(err)}`, cause: err })
      }).pipe(Effect.asVoid)

    return LinearSdkClient.of({
      listIssues,
      getIssue,
      listWorkflowStates,
      updateIssue,
      updateIssuePriority
    })
  })
)
