/**
 * Dynamic layer map for selecting SpecUploader implementation at runtime
 * @since 1.0.0
 */
import { LayerMap } from "effect"
import { CloudflareSpecUploaderLive, GistSpecUploaderLive, TelegraphSpecUploaderLive } from "./SpecUploader.js"

/**
 * @since 1.0.0
 * @category layer-map
 */
export class SpecUploaderMap extends LayerMap.Service<SpecUploaderMap>()("SpecUploaderMap", {
  layers: {
    cloudflare: CloudflareSpecUploaderLive,
    gist: GistSpecUploaderLive,
    telegraph: TelegraphSpecUploaderLive
  }
}) {}
