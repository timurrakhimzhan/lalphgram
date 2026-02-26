/**
 * Octokit SDK client service
 * @since 1.0.0
 */
import { Context, Data, Effect, Layer } from "effect"
import { Octokit } from "octokit"
import { LalphConfig } from "./LalphConfig.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class OctokitClientError extends Data.TaggedError("OctokitClientError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitUser {
  readonly login: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitRepo {
  readonly id: number
  readonly name: string
  readonly fullName: string
  readonly owner: { readonly login: string }
  readonly htmlUrl: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitPullRequest {
  readonly id: number
  readonly number: number
  readonly title: string
  readonly state: string
  readonly htmlUrl: string
  readonly head: { readonly ref: string; readonly sha: string }
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitPullRequestDetail extends OctokitPullRequest {
  readonly mergeable: boolean | null
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitComment {
  readonly id: number
  readonly body?: string | null
  readonly user: { readonly login: string } | null
  readonly createdAt: string
  readonly htmlUrl: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitIssue {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly htmlUrl: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly repositoryUrl: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitIssueDetail {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly htmlUrl: string
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitCheckRun {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly htmlUrl: string
  readonly output: { readonly title: string | null; readonly summary: string | null } | null
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitCombinedStatus {
  readonly state: string
  readonly statuses: ReadonlyArray<{
    readonly state: string
    readonly context: string
  }>
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitMergeResult {
  readonly sha: string
  readonly merged: boolean
  readonly message: string
}

/**
 * @since 1.0.0
 * @category models
 */
export interface OctokitGist {
  readonly id: string
  readonly htmlUrl: string
  readonly files: Record<string, { readonly rawUrl: string }>
}

/**
 * @since 1.0.0
 * @category services
 */
export interface OctokitClientService {
  readonly getAuthenticatedUser: () => Effect.Effect<OctokitUser, OctokitClientError>
  readonly listUserRepos: (params: {
    readonly perPage: number
    readonly type: "all" | "owner" | "public" | "private" | "member"
  }) => Effect.Effect<ReadonlyArray<OctokitRepo>, OctokitClientError>
  readonly listPulls: (params: {
    readonly owner: string
    readonly repo: string
    readonly state: "open" | "closed" | "all"
    readonly perPage: number
  }) => Effect.Effect<ReadonlyArray<OctokitPullRequest>, OctokitClientError>
  readonly getPull: (params: {
    readonly owner: string
    readonly repo: string
    readonly pullNumber: number
  }) => Effect.Effect<OctokitPullRequestDetail, OctokitClientError>
  readonly createIssueComment: (params: {
    readonly owner: string
    readonly repo: string
    readonly issueNumber: number
    readonly body: string
  }) => Effect.Effect<void, OctokitClientError>
  readonly listIssueComments: (params: {
    readonly owner: string
    readonly repo: string
    readonly issueNumber: number
    readonly perPage: number
  }) => Effect.Effect<ReadonlyArray<OctokitComment>, OctokitClientError>
  readonly listUserIssues: (params: {
    readonly state: "open" | "closed" | "all"
    readonly sort: "created" | "updated" | "comments"
    readonly since?: string
  }) => Effect.Effect<ReadonlyArray<OctokitIssue>, OctokitClientError>
  readonly getIssue: (params: {
    readonly owner: string
    readonly repo: string
    readonly issueNumber: number
  }) => Effect.Effect<OctokitIssueDetail, OctokitClientError>
  readonly addIssueLabels: (params: {
    readonly owner: string
    readonly repo: string
    readonly issueNumber: number
    readonly labels: ReadonlyArray<string>
  }) => Effect.Effect<void, OctokitClientError>
  readonly listPullReviewComments: (params: {
    readonly owner: string
    readonly repo: string
    readonly pullNumber: number
    readonly perPage: number
  }) => Effect.Effect<ReadonlyArray<OctokitComment>, OctokitClientError>
  readonly getCombinedStatusForRef: (params: {
    readonly owner: string
    readonly repo: string
    readonly ref: string
  }) => Effect.Effect<OctokitCombinedStatus, OctokitClientError>
  readonly listCheckRunsForRef: (params: {
    readonly owner: string
    readonly repo: string
    readonly ref: string
  }) => Effect.Effect<ReadonlyArray<OctokitCheckRun>, OctokitClientError>
  readonly mergePull: (params: {
    readonly owner: string
    readonly repo: string
    readonly pullNumber: number
  }) => Effect.Effect<OctokitMergeResult, OctokitClientError>
  readonly createGist: (params: {
    readonly description: string
    readonly files: Record<string, { readonly content: string }>
    readonly isPublic: boolean
  }) => Effect.Effect<OctokitGist, OctokitClientError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class OctokitClient extends Context.Tag("OctokitClient")<OctokitClient, OctokitClientService>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const OctokitClientLive = Layer.effect(
  OctokitClient,
  Effect.gen(function*() {
    const watcher = yield* LalphConfig
    const initialToken = yield* watcher.githubToken.pipe(
      Effect.mapError((err) => new OctokitClientError({ message: err.message, cause: err }))
    )

    let currentToken = initialToken
    let octokit = new Octokit({ auth: currentToken })

    const getClient = Effect.gen(function*() {
      const latestToken = yield* watcher.githubToken.pipe(
        Effect.mapError((err) => new OctokitClientError({ message: err.message, cause: err }))
      )
      if (latestToken !== currentToken) {
        currentToken = latestToken
        octokit = new Octokit({ auth: latestToken })
      }
      return octokit
    })

    const getAuthenticatedUser = () =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () => client.rest.users.getAuthenticated(),
          catch: (err) =>
            new OctokitClientError({ message: `Failed to get authenticated user: ${String(err)}`, cause: err })
        }).pipe(Effect.map((response) => response.data))
      })

    const listUserRepos = (params: {
      readonly perPage: number
      readonly type: "all" | "owner" | "public" | "private" | "member"
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () => client.rest.repos.listForAuthenticatedUser({ per_page: params.perPage, type: params.type }),
          catch: (err) => new OctokitClientError({ message: `Failed to list user repos: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) =>
            response.data.map((r) => ({
              id: r.id,
              name: r.name,
              fullName: r.full_name,
              owner: { login: r.owner.login },
              htmlUrl: r.html_url
            }))
          )
        )
      })

    const listPulls = (params: {
      readonly owner: string
      readonly repo: string
      readonly state: "open" | "closed" | "all"
      readonly perPage: number
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.pulls.list({
              owner: params.owner,
              repo: params.repo,
              state: params.state,
              per_page: params.perPage
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to list pulls: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) =>
            response.data.map((p) => ({
              id: p.id,
              number: p.number,
              title: p.title,
              state: p.state,
              htmlUrl: p.html_url,
              head: { ref: p.head.ref, sha: p.head.sha }
            }))
          )
        )
      })

    const getPull = (params: {
      readonly owner: string
      readonly repo: string
      readonly pullNumber: number
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.pulls.get({
              owner: params.owner,
              repo: params.repo,
              pull_number: params.pullNumber
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to get pull: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) => ({
            id: response.data.id,
            number: response.data.number,
            title: response.data.title,
            state: response.data.state,
            htmlUrl: response.data.html_url,
            head: { ref: response.data.head.ref, sha: response.data.head.sha },
            mergeable: response.data.mergeable
          }))
        )
      })

    const createIssueComment = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
      readonly body: string
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.issues.createComment({
              owner: params.owner,
              repo: params.repo,
              issue_number: params.issueNumber,
              body: params.body
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to create comment: ${String(err)}`, cause: err })
        }).pipe(Effect.asVoid)
      })

    const listIssueComments = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
      readonly perPage: number
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.issues.listComments({
              owner: params.owner,
              repo: params.repo,
              issue_number: params.issueNumber,
              per_page: params.perPage
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to list comments: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) =>
            response.data.map((c): OctokitComment => ({
              id: c.id,
              body: c.body ?? null,
              user: c.user ? { login: c.user.login } : null,
              createdAt: c.created_at,
              htmlUrl: c.html_url
            }))
          )
        )
      })

    const listUserIssues = (params: {
      readonly state: "open" | "closed" | "all"
      readonly sort: "created" | "updated" | "comments"
      readonly since?: string
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.issues.listForAuthenticatedUser({
              filter: "all",
              state: params.state,
              sort: params.sort,
              since: params.since
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to list user issues: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) =>
            response.data.filter((i) => !i.pull_request).map((i): OctokitIssue => ({
              number: i.number,
              title: i.title,
              state: i.state,
              htmlUrl: i.html_url,
              createdAt: i.created_at,
              updatedAt: i.updated_at,
              repositoryUrl: i.repository_url
            }))
          )
        )
      })

    const getIssue = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.issues.get({
              owner: params.owner,
              repo: params.repo,
              issue_number: params.issueNumber
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to get issue: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response): OctokitIssueDetail => ({
            number: response.data.number,
            title: response.data.title,
            state: response.data.state,
            htmlUrl: response.data.html_url,
            createdAt: response.data.created_at,
            updatedAt: response.data.updated_at
          }))
        )
      })

    const addIssueLabels = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
      readonly labels: ReadonlyArray<string>
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.issues.addLabels({
              owner: params.owner,
              repo: params.repo,
              issue_number: params.issueNumber,
              labels: [...params.labels]
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to add issue labels: ${String(err)}`, cause: err })
        }).pipe(Effect.asVoid)
      })

    const listPullReviewComments = (params: {
      readonly owner: string
      readonly repo: string
      readonly pullNumber: number
      readonly perPage: number
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.pulls.listReviewComments({
              owner: params.owner,
              repo: params.repo,
              pull_number: params.pullNumber,
              per_page: params.perPage
            }),
          catch: (err) =>
            new OctokitClientError({ message: `Failed to list pull review comments: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) =>
            response.data.map((c): OctokitComment => ({
              id: c.id,
              body: c.body ?? null,
              user: c.user ? { login: c.user.login } : null,
              createdAt: c.created_at,
              htmlUrl: c.html_url
            }))
          )
        )
      })

    const getCombinedStatusForRef = (params: {
      readonly owner: string
      readonly repo: string
      readonly ref: string
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.repos.getCombinedStatusForRef({
              owner: params.owner,
              repo: params.repo,
              ref: params.ref
            }),
          catch: (err) =>
            new OctokitClientError({ message: `Failed to get combined status for ref: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response): OctokitCombinedStatus => ({
            state: response.data.state,
            statuses: response.data.statuses.map((s) => ({
              state: s.state,
              context: s.context
            }))
          }))
        )
      })

    const listCheckRunsForRef = (params: {
      readonly owner: string
      readonly repo: string
      readonly ref: string
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.checks.listForRef({
              owner: params.owner,
              repo: params.repo,
              ref: params.ref
            }),
          catch: (err) =>
            new OctokitClientError({ message: `Failed to list check runs for ref: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response) =>
            response.data.check_runs.map((cr): OctokitCheckRun => ({
              id: cr.id,
              name: cr.name,
              status: cr.status,
              conclusion: cr.conclusion ?? null,
              htmlUrl: cr.html_url ?? "",
              output: cr.output ? { title: cr.output.title ?? null, summary: cr.output.summary ?? null } : null
            }))
          )
        )
      })

    const mergePull = (params: {
      readonly owner: string
      readonly repo: string
      readonly pullNumber: number
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.pulls.merge({
              owner: params.owner,
              repo: params.repo,
              pull_number: params.pullNumber
            }),
          catch: (err) =>
            new OctokitClientError({ message: `Failed to merge pull request: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response): OctokitMergeResult => ({
            sha: response.data.sha,
            merged: response.data.merged,
            message: response.data.message
          }))
        )
      })

    const createGist = (params: {
      readonly description: string
      readonly files: Record<string, { readonly content: string }>
      readonly isPublic: boolean
    }) =>
      Effect.gen(function*() {
        const client = yield* getClient
        return yield* Effect.tryPromise({
          try: () =>
            client.rest.gists.create({
              description: params.description,
              public: params.isPublic,
              files: params.files
            }),
          catch: (err) => new OctokitClientError({ message: `Failed to create gist: ${String(err)}`, cause: err })
        }).pipe(
          Effect.map((response): OctokitGist => ({
            id: response.data.id ?? "",
            htmlUrl: response.data.html_url ?? "",
            files: Object.fromEntries(
              Object.entries(response.data.files ?? {}).map(([name, file]) => [
                name,
                { rawUrl: file?.raw_url ?? "" }
              ])
            )
          }))
        )
      })

    return OctokitClient.of({
      getAuthenticatedUser,
      listUserRepos,
      listPulls,
      getPull,
      createIssueComment,
      listIssueComments,
      listUserIssues,
      getIssue,
      addIssueLabels,
      listPullReviewComments,
      getCombinedStatusForRef,
      listCheckRunsForRef,
      mergePull,
      createGist
    })
  })
)
