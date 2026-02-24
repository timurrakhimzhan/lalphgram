import { describe, expect, it } from "@effect/vitest"
import { toTelegraphHtml } from "../src/lib/TelegraphHtml.js"

const wrapInFullHtml = (body: string) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Spec Files</title>
  <style>body { font-family: sans-serif; }</style>
</head>
<body>
${body}
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`

describe("toTelegraphHtml", () => {
  it("extracts body content and strips head, scripts, and styles", () => {
    // Arrange
    const html = wrapInFullHtml("<p>Hello world</p>")

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    expect(result).toContain("<p>Hello world</p>")
    expect(result).not.toContain("<!DOCTYPE")
    expect(result).not.toContain("<head>")
    expect(result).not.toContain("<style>")
    expect(result).not.toContain("<script")
    expect(result).not.toContain("mermaid.initialize")
  })

  it("replaces mermaid pre blocks with kroki img tags", () => {
    // Arrange
    const mermaidContent = "classDiagram\n    class Foo {\n        +bar() string\n    }"
    const escaped = mermaidContent
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
    const html = wrapInFullHtml(`<pre class="mermaid">${escaped}</pre>`)

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    expect(result).not.toContain("<pre class=\"mermaid\">")
    expect(result).toMatch(/<img src="https:\/\/kroki\.io\/plantuml\/svg\/[A-Za-z0-9_-]+"/)
  })

  it("downgrades h1 and h2 to h3", () => {
    // Arrange
    const html = wrapInFullHtml("<h1>Title</h1>\n<h2>Subtitle</h2>\n<h3>Section</h3>")

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    expect(result).toContain("<h3>Title</h3>")
    expect(result).toContain("<h3>Subtitle</h3>")
    expect(result).toContain("<h3>Section</h3>")
    expect(result).not.toContain("<h1>")
    expect(result).not.toContain("<h2>")
  })

  it("downgrades h5 and h6 to h4", () => {
    // Arrange
    const html = wrapInFullHtml("<h5>Small</h5>\n<h6>Tiny</h6>\n<h4>Normal</h4>")

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    expect(result).toContain("<h4>Small</h4>")
    expect(result).toContain("<h4>Tiny</h4>")
    expect(result).toContain("<h4>Normal</h4>")
    expect(result).not.toContain("<h5>")
    expect(result).not.toContain("<h6>")
  })

  it("preserves h3 and h4 unchanged", () => {
    // Arrange
    const html = wrapInFullHtml("<h3>Section</h3>\n<h4>Subsection</h4>")

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    expect(result).toContain("<h3>Section</h3>")
    expect(result).toContain("<h4>Subsection</h4>")
  })

  it("handles multiple mermaid blocks", () => {
    // Arrange
    const block1 = "classDiagram\n    class A {\n        +foo() void\n    }"
    const block2 = "classDiagram\n    class B {\n        +bar() void\n    }"
    const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    const html = wrapInFullHtml(
      `<pre class="mermaid">${escape(block1)}</pre>\n<p>Text between</p>\n<pre class="mermaid">${escape(block2)}</pre>`
    )

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    const imgMatches = result.match(/<img src="https:\/\/kroki\.io\/plantuml\/svg\/[^"]+"/g)
    expect(imgMatches).toHaveLength(2)
    expect(result).toContain("<p>Text between</p>")
  })

  it("unescapes HTML entities in mermaid content before conversion", () => {
    // Arrange — Record~string, RawUrl~ gets HTML-escaped by generateSpecHtml
    const mermaidRaw = "classDiagram\n    class Gist {\n        +files Record~string, RawUrl~\n    }"
    const escaped = mermaidRaw
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
    const html = wrapInFullHtml(`<pre class="mermaid">${escaped}</pre>`)

    // Act
    const result = toTelegraphHtml(html)

    // Assert — the kroki URL should encode the PlantUML with <string, RawUrl> (converted from ~)
    expect(result).toMatch(/<img src="https:\/\/kroki\.io\/plantuml\/svg\/[A-Za-z0-9_-]+"/)
    expect(result).not.toContain("<pre class=\"mermaid\">")
  })

  it("falls back to full input when no body tag found", () => {
    // Arrange
    const html = "<h2>No body wrapper</h2><p>Content</p>"

    // Act
    const result = toTelegraphHtml(html)

    // Assert
    expect(result).toContain("<h3>No body wrapper</h3>")
    expect(result).toContain("<p>Content</p>")
  })
})
