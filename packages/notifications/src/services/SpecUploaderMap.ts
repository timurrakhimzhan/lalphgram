/**
 * Dynamic layer map for selecting SpecUploader implementation at runtime
 * @since 1.0.0
 */
import { LayerMap } from "effect"
import { GistSpecUploaderLive, TelegraphSpecUploaderLive } from "./SpecUploader.js"

/**
 * @since 1.0.0
 * @category layer-map
 */
export class SpecUploaderMap extends LayerMap.Service<SpecUploaderMap>()("SpecUploaderMap", {
  layers: {
    gist: GistSpecUploaderLive,
    telegraph: TelegraphSpecUploaderLive
  }
}) {}
