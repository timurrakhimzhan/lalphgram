/**
 * Linear API response schemas
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export class LinearIssueNode extends Schema.Class<LinearIssueNode>("LinearIssueNode")({
  id: Schema.String,
  title: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  state: Schema.Struct({
    name: Schema.String
  })
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class LinearIssuesResponse extends Schema.Class<LinearIssuesResponse>("LinearIssuesResponse")({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(LinearIssueNode)
    })
  })
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class LinearWorkflowState extends Schema.Class<LinearWorkflowState>("LinearWorkflowState")({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class LinearWorkflowStatesResponse extends Schema.Class<LinearWorkflowStatesResponse>(
  "LinearWorkflowStatesResponse"
)({
  data: Schema.Struct({
    workflowStates: Schema.Struct({
      nodes: Schema.Array(LinearWorkflowState)
    })
  })
}) {}
