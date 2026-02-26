/**
 * GitHub REST API client service
 * @since 1.0.0
 */
import { Array, Context, Data, Effect, Layer } from "effect"
import { GitHubComment, GitHubPullRequest, GitHubRepo } from "../schemas/GitHubSchemas.js"
import { OctokitClient } from "./OctokitClient.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class GitHubClientError extends Data.TaggedError("GitHubClientError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category models
 */
export interface GitHubCheckRun {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly html_url: string
  readonly output: { readonly title: string | null; readonly summary: string | null } | null
}

/**
 * @since 1.0.0
 * @category models
 */
export interface GitHubCIStatus {
  readonly state: string
  readonly checkRuns: ReadonlyArray<GitHubCheckRun>
}

/**
 * @since 1.0.0
 * @category services
 */
export interface GitHubClientService {
  readonly getAuthenticatedUser: () => Effect.Effect<{ readonly login: string }, GitHubClientError>
  readonly listUserRepos: () => Effect.Effect<ReadonlyArray<GitHubRepo>, GitHubClientError>
  readonly listOpenPRs: (repo: GitHubRepo) => Effect.Effect<ReadonlyArray<GitHubPullRequest>, GitHubClientError>
  readonly getPR: (repo: GitHubRepo, prNumber: number) => Effect.Effect<GitHubPullRequest, GitHubClientError>
  readonly postComment: (
    repo: GitHubRepo,
    prNumber: number,
    body: string
  ) => Effect.Effect<void, GitHubClientError>
  readonly listComments: (
    repo: GitHubRepo,
    prNumber: number
  ) => Effect.Effect<ReadonlyArray<GitHubComment>, GitHubClientError>
  readonly listReviewComments: (
    repo: GitHubRepo,
    prNumber: number
  ) => Effect.Effect<ReadonlyArray<GitHubComment>, GitHubClientError>
  readonly getCIStatus: (
    repo: GitHubRepo,
    ref: string
  ) => Effect.Effect<GitHubCIStatus, GitHubClientError>
  readonly mergePR: (
    repo: GitHubRepo,
    prNumber: number
  ) => Effect.Effect<void, GitHubClientError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class GitHubClient extends Context.Tag("GitHubClient")<GitHubClient, GitHubClientService>() {}

const splitFullName = (fullName: string): { owner: string; repo: string } => {
  const slashIndex = fullName.indexOf("/")
  return {
    owner: fullName.substring(0, slashIndex),
    repo: fullName.substring(slashIndex + 1)
  }
}

/**
 * @since 1.0.0
 * @category layers
 */
export const GitHubClientLive = Layer.effect(
  GitHubClient,
  Effect.gen(function*() {
    const octokit = yield* OctokitClient

    const getAuthenticatedUser = () =>
      octokit.getAuthenticatedUser().pipe(
        Effect.map((user) => ({ login: user.login })),
        Effect.mapError((err) =>
          new GitHubClientError({ message: `Failed to get authenticated user: ${err.message}`, cause: err })
        )
      )

    const listUserRepos = () =>
      octokit.listUserRepos({ perPage: 100, type: "owner" }).pipe(
        Effect.map((repos) =>
          Array.map(repos, (r) =>
            new GitHubRepo({
              id: r.id,
              name: r.name,
              full_name: r.fullName,
              owner: { login: r.owner.login },
              html_url: r.htmlUrl
            }))
        ),
        Effect.mapError((err) =>
          new GitHubClientError({ message: `Failed to list user repos: ${err.message}`, cause: err })
        )
      )

    const listOpenPRs = (repo: GitHubRepo) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return octokit.listPulls({ owner, repo: repoName, state: "open", perPage: 100 }).pipe(
        Effect.flatMap((pulls) =>
          Effect.forEach(pulls, (raw) =>
            octokit.getPull({ owner, repo: repoName, pullNumber: raw.number }).pipe(
              Effect.map((detail) =>
                new GitHubPullRequest({
                  id: raw.id,
                  number: raw.number,
                  title: raw.title,
                  state: raw.state,
                  html_url: raw.htmlUrl,
                  headRef: raw.head.ref,
                  headSha: raw.head.sha,
                  hasConflicts: detail.mergeable === false,
                  repo: repo.full_name
                })
              )
            ))
        ),
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to list open PRs for ${repo.full_name}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    const getPR = (repo: GitHubRepo, prNumber: number) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return octokit.getPull({ owner, repo: repoName, pullNumber: prNumber }).pipe(
        Effect.map((raw) =>
          new GitHubPullRequest({
            id: raw.id,
            number: raw.number,
            title: raw.title,
            state: raw.state,
            html_url: raw.htmlUrl,
            headRef: raw.head.ref,
            headSha: raw.head.sha,
            hasConflicts: raw.mergeable === false,
            repo: repo.full_name
          })
        ),
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to get PR #${prNumber} for ${repo.full_name}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    const postComment = (repo: GitHubRepo, prNumber: number, body: string) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return octokit.createIssueComment({ owner, repo: repoName, issueNumber: prNumber, body }).pipe(
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to post comment on PR #${prNumber} for ${repo.full_name}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    const listComments = (repo: GitHubRepo, prNumber: number) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return octokit.listIssueComments({ owner, repo: repoName, issueNumber: prNumber, perPage: 100 }).pipe(
        Effect.map((comments) =>
          Array.map(comments, (raw) =>
            new GitHubComment({
              id: raw.id,
              body: raw.body ?? "",
              user: { login: raw.user?.login ?? "" },
              created_at: raw.createdAt,
              html_url: raw.htmlUrl,
              repo: repo.full_name
            }))
        ),
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to list comments on PR #${prNumber} for ${repo.full_name}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    const listReviewComments = (repo: GitHubRepo, prNumber: number) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return octokit.listPullReviewComments({ owner, repo: repoName, pullNumber: prNumber, perPage: 100 }).pipe(
        Effect.map((comments) =>
          Array.map(comments, (raw) =>
            new GitHubComment({
              id: raw.id,
              body: raw.body ?? "",
              user: { login: raw.user?.login ?? "" },
              created_at: raw.createdAt,
              html_url: raw.htmlUrl,
              repo: repo.full_name
            }))
        ),
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to list review comments on PR #${prNumber} for ${repo.full_name}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    const getCIStatus = (repo: GitHubRepo, ref: string) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return Effect.all({
        combinedStatus: octokit.getCombinedStatusForRef({ owner, repo: repoName, ref }),
        checkRuns: octokit.listCheckRunsForRef({ owner, repo: repoName, ref })
      }).pipe(
        Effect.map(({ checkRuns, combinedStatus }) => ({
          state: combinedStatus.state,
          checkRuns: Array.map(checkRuns, (cr) => ({
            id: cr.id,
            name: cr.name,
            status: cr.status,
            conclusion: cr.conclusion,
            html_url: cr.htmlUrl,
            output: cr.output
          }))
        })),
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to get CI status for ${repo.full_name} ref ${ref}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    const mergePR = (repo: GitHubRepo, prNumber: number) => {
      const { owner, repo: repoName } = splitFullName(repo.full_name)
      return octokit.mergePull({ owner, repo: repoName, pullNumber: prNumber }).pipe(
        Effect.asVoid,
        Effect.mapError((err) =>
          new GitHubClientError({
            message: `Failed to merge PR #${prNumber} for ${repo.full_name}: ${err.message}`,
            cause: err
          })
        )
      )
    }

    return GitHubClient.of({
      getAuthenticatedUser,
      listUserRepos,
      listOpenPRs,
      getPR,
      postComment,
      listComments,
      listReviewComments,
      getCIStatus,
      mergePR
    })
  })
)
