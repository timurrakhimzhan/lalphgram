/**
 * Branch name parser to extract issue IDs
 * @since 1.0.0
 */
import { Option } from "effect"

const linearPattern = /^([A-Z]+-\d+)\//
const linearAnywhere = /([A-Z]+-\d+)/
const githubIssuePattern = /^(\d+)-/
const githubIssueAnywhere = /(?:^|\/|-)(\d+)(?:-|$)/

/**
 * Extract an issue ID from a git branch name.
 *
 * Tries patterns in order:
 * 1. Linear-style prefix: `ABC-123/description` → `ABC-123`
 * 2. Linear-style anywhere: `feature/ABC-123-description` → `ABC-123`
 * 3. GitHub issue prefix: `123-description` → `123`
 * 4. GitHub issue anywhere: `feature/123-description` → `123`
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
