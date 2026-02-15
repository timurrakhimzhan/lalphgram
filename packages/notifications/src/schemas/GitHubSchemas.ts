/**
 * GitHub API response schemas
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export class GitHubRepo extends Schema.Class<GitHubRepo>("GitHubRepo")({
  id: Schema.Number,
  name: Schema.String,
  full_name: Schema.String,
  owner: Schema.Struct({
    login: Schema.String
  }),
  html_url: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class GitHubPullRequest extends Schema.Class<GitHubPullRequest>("GitHubPullRequest")({
  id: Schema.Number,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  html_url: Schema.String,
  headRef: Schema.propertySignature(Schema.String).pipe(Schema.fromKey("head_ref")),
  hasConflicts: Schema.Boolean,
  repo: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class GitHubComment extends Schema.Class<GitHubComment>("GitHubComment")({
  id: Schema.Number,
  body: Schema.String,
  user: Schema.Struct({
    login: Schema.String
  }),
  created_at: Schema.String,
  html_url: Schema.String,
  repo: Schema.optionalWith(Schema.String, { default: () => "" })
}) {}
