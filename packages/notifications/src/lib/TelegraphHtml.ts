/**
 * Transforms HTML from generateSpecHtml into Telegraph-compatible Node array.
 * Replaces Mermaid diagram blocks with pre-rendered PlantUML images via kroki.io.
 * Uses better-telegraph's parseHtml for HTML → Telegraph Node conversion.
 * @since 1.0.0
 */
import { parseHtml } from "better-telegraph"
import { deflateSync } from "node:zlib"
import { mermaidToPlantUml } from "./MermaidToPlantUml.js"

/**
 * Unescape HTML entities back to raw text.
 */
const unescapeHtml = (html: string): string =>
  html
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")

/**
 * Encode a PlantUML diagram for the kroki.io API.
 * Uses zlib deflate + base64url encoding.
 */
const encodeForKroki = (plantuml: string): string => {
  const compressed = deflateSync(Buffer.from(plantuml, "utf-8"))
  return compressed.toString("base64url")
}

/**
 * Build a kroki.io PlantUML SVG URL from a Mermaid class diagram string.
 */
const mermaidToKrokiUrl = (mermaidContent: string): string => {
  const plantuml = mermaidToPlantUml(mermaidContent)
  const encoded = encodeForKroki(plantuml)
  return `https://kroki.io/plantuml/svg/${encoded}`
}

/**
 * Transform HTML produced by `generateSpecHtml` into Telegraph-compatible content.
 *
 * - Extracts `<body>` content (strips doctype, head, scripts, styles)
 * - Replaces `<pre class="mermaid">content</pre>` with `<img src="kroki_url">`
 * - Parses via `better-telegraph`'s `parseHtml` which handles heading downgrades
 *   and converts to Telegraph's Node format
 * @since 1.0.0
 */
export const toTelegraphContent = (html: string): ReadonlyArray<unknown> => {
  // Extract body content
  const bodyMatch = /<body>([\s\S]*)<\/body>/i.exec(html)
  let content = bodyMatch?.[1] ?? html

  // Strip <script> tags
  content = content.replace(/<script[\s\S]*?<\/script>/gi, "")

  // Strip <style> tags
  content = content.replace(/<style[\s\S]*?<\/style>/gi, "")

  // Replace <pre class="mermaid">content</pre> with <img> tags
  content = content.replace(
    /<pre class="mermaid">([\s\S]*?)<\/pre>/g,
    (_, mermaidHtml: string) => {
      const rawMermaid = unescapeHtml(mermaidHtml)
      const url = mermaidToKrokiUrl(rawMermaid)
      return `<img src="${url}">`
    }
  )

  const parsed = parseHtml(content)
  if (parsed == null) return []
  return typeof parsed === "string" ? [parsed] : parsed
}
