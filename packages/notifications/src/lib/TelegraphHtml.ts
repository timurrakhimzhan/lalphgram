/**
 * Transforms HTML from generateSpecHtml into Telegraph-compatible HTML.
 * Replaces Mermaid diagram blocks with pre-rendered PlantUML images via kroki.io.
 * @since 1.0.0
 */
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
 * Transform HTML produced by `generateSpecHtml` into Telegraph-compatible HTML.
 *
 * - Extracts `<body>` content (strips doctype, head, scripts, styles)
 * - Replaces `<pre class="mermaid">content</pre>` with `<img src="kroki_url">`
 * - Replaces `<h1>`, `<h2>` → `<h3>` (Telegraph only supports h3/h4)
 * - Replaces `<h5>`, `<h6>` → `<h4>`
 * @since 1.0.0
 */
export const toTelegraphHtml = (html: string): string => {
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

  // Downgrade headings for Telegraph compatibility
  // h1, h2 → h3
  content = content.replace(/<h[12]>/gi, "<h3>")
  content = content.replace(/<\/h[12]>/gi, "</h3>")
  // h5, h6 → h4
  content = content.replace(/<h[56]>/gi, "<h4>")
  content = content.replace(/<\/h[56]>/gi, "</h4>")

  return content.trim()
}
