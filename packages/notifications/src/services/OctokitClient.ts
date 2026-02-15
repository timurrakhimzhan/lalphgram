/**
 * Octokit SDK client service
 * @since 1.0.0
 */
import { Context, Data, Effect, Layer } from "effect"
import { Octokit } from "octokit"
import { AppCredentials } from "../schemas/CredentialSchemas.js"

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
  readonly head: { readonly ref: string }
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
    const creds = yield* AppCredentials
    const octokit = new Octokit({ auth: creds.githubToken })

    const getAuthenticatedUser = () =>
      Effect.tryPromise({
        try: () => octokit.rest.users.getAuthenticated(),
        catch: (err) =>
          new OctokitClientError({ message: `Failed to get authenticated user: ${String(err)}`, cause: err })
      }).pipe(
        Effect.map((response) => response.data)
      )

    const listUserRepos = (params: {
      readonly perPage: number
      readonly type: "all" | "owner" | "public" | "private" | "member"
    }) =>
      Effect.tryPromise({
        try: () => octokit.rest.repos.listForAuthenticatedUser({ per_page: params.perPage, type: params.type }),
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

    const listPulls = (params: {
      readonly owner: string
      readonly repo: string
      readonly state: "open" | "closed" | "all"
      readonly perPage: number
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.pulls.list({
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
            head: { ref: p.head.ref }
          }))
        )
      )

    const getPull = (params: {
      readonly owner: string
      readonly repo: string
      readonly pullNumber: number
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.pulls.get({
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
          head: { ref: response.data.head.ref },
          mergeable: response.data.mergeable
        }))
      )

    const createIssueComment = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
      readonly body: string
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.issues.createComment({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            body: params.body
          }),
        catch: (err) => new OctokitClientError({ message: `Failed to create comment: ${String(err)}`, cause: err })
      }).pipe(Effect.asVoid)

    const listIssueComments = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
      readonly perPage: number
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.issues.listComments({
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

    const listUserIssues = (params: {
      readonly state: "open" | "closed" | "all"
      readonly sort: "created" | "updated" | "comments"
      readonly since?: string
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.issues.listForAuthenticatedUser({
            filter: "all",
            state: params.state,
            sort: params.sort,
            since: params.since
          }),
        catch: (err) => new OctokitClientError({ message: `Failed to list user issues: ${String(err)}`, cause: err })
      }).pipe(
        Effect.map((response) =>
          response.data.map((i): OctokitIssue => ({
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

    const getIssue = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.issues.get({
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

    const addIssueLabels = (params: {
      readonly owner: string
      readonly repo: string
      readonly issueNumber: number
      readonly labels: ReadonlyArray<string>
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.issues.addLabels({
            owner: params.owner,
            repo: params.repo,
            issue_number: params.issueNumber,
            labels: [...params.labels]
          }),
        catch: (err) => new OctokitClientError({ message: `Failed to add issue labels: ${String(err)}`, cause: err })
      }).pipe(Effect.asVoid)

    const listPullReviewComments = (params: {
      readonly owner: string
      readonly repo: string
      readonly pullNumber: number
      readonly perPage: number
    }) =>
      Effect.tryPromise({
        try: () =>
          octokit.rest.pulls.listReviewComments({
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
      listPullReviewComments
    })
  })
)
