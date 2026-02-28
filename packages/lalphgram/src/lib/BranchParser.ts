/**
 * Branch name parser service to extract and resolve issue IDs
 * @since 1.0.0
 */
import { Context, Layer, Option } from "effect"
import type { GitHubPullRequest } from "../schemas/GitHubSchemas.js"

const linearPattern = /^([A-Z]+-\d+)\//
const linearAnywhere = /([A-Z]+-\d+)/
const githubIssuePattern = /^#?(\d+)\//
const githubIssueAnywhere = /(?:^|\/)#?(\d+)(?:\/|$)/

const linearIdPattern = /^[A-Z]+-\d+$/

/**
 * Extract a raw issue ID from a git branch name.
 *
 * Tries patterns in order:
 * 1. Linear-style prefix: `ABC-123/description` → `ABC-123`
 * 2. Linear-style anywhere: `feature/ABC-123-description` → `ABC-123`
 * 3. GitHub issue prefix: `#42/description` or `42/description` → `42`
 * 4. GitHub issue anywhere: `feature/#42/description` → `42`
 *
 * @since 1.0.0
 * @category parsers
 */
export const extractIssueId = (branch: string): Option.Option<string> =>
  Option.fromNullable(linearPattern.exec(branch)?.[1]).pipe(
    Option.orElse(() => Option.fromNullable(linearAnywhere.exec(branch)?.[1])),
    Option.orElse(() => Option.fromNullable(githubIssuePattern.exec(branch)?.[1])),
    Option.orElse(() => Option.fromNullable(githubIssueAnywhere.exec(branch)?.[1]))
  )

/**
 * @since 1.0.0
 * @category services
 */
export interface BranchParserService {
  readonly resolveIssueId: (pr: GitHubPullRequest) => Option.Option<string>
}

/**
 * @since 1.0.0
 * @category context
 */
export class BranchParser extends Context.Tag("BranchParser")<BranchParser, BranchParserService>() {}

/**
 * @since 1.0.0
 * @category layers
 */
export const BranchParserLive = Layer.succeed(
  BranchParser,
  BranchParser.of({
    resolveIssueId: (pr) =>
      Option.map(extractIssueId(pr.headRef), (id) => linearIdPattern.test(id) ? id : `${pr.repo}#${id}`)
  })
)
