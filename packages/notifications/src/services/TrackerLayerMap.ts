/**
 * Dynamic layer map for selecting TaskTracker implementation at runtime
 * @since 1.0.0
 */
import { Layer, LayerMap } from "effect"
import { GitHubIssueTrackerLive } from "./GitHubIssueTracker.js"
import { LinearSdkClientLive } from "./LinearSdkClient.js"
import { LinearTrackerLive } from "./LinearTracker.js"

/**
 * @since 1.0.0
 * @category layer-map
 */
export class TrackerLayerMap extends LayerMap.Service<TrackerLayerMap>()("TrackerLayerMap", {
  layers: {
    linear: LinearTrackerLive.pipe(Layer.provide(LinearSdkClientLive)),
    github: GitHubIssueTrackerLive
  }
}) {}
