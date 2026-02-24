/**
 * Dynamic layer map for selecting PlanOverviewUploader implementation at runtime
 * @since 1.0.0
 */
import { LayerMap } from "effect"
import { GistPlanOverviewUploaderLive, TelegraphPlanOverviewUploaderLive } from "./PlanOverviewUploader.js"

/**
 * @since 1.0.0
 * @category layer-map
 */
export class PlanOverviewUploaderMap extends LayerMap.Service<PlanOverviewUploaderMap>()("PlanOverviewUploaderMap", {
  layers: {
    gist: GistPlanOverviewUploaderLive,
    telegraph: TelegraphPlanOverviewUploaderLive
  }
}) {}
