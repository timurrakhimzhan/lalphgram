/**
 * Tracker schemas for task tracking events
 * @since 1.0.0
 */
import { Schema } from "effect"

/**
 * @since 1.0.0
 * @category schemas
 */
export class TrackerIssue extends Schema.Class<TrackerIssue>("TrackerIssue")({
  id: Schema.String,
  title: Schema.String,
  state: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

/**
 * @since 1.0.0
 * @category schemas
 */
export class TrackerIssueEvent extends Schema.Class<TrackerIssueEvent>("TrackerIssueEvent")({
  action: Schema.Literal("created", "updated"),
  issue: TrackerIssue
}) {}
