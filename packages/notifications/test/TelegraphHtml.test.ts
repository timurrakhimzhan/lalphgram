import { describe, expect, it } from "@effect/vitest"
import { toTelegraphContent } from "../src/lib/TelegraphHtml.js"

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

const stringify = (nodes: ReadonlyArray<unknown>): string => JSON.stringify(nodes)

describe("toTelegraphContent", () => {
  it("extracts body content and strips scripts and styles", () => {
    // Arrange
    const html = wrapInFullHtml("<p>Hello world</p>")

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    expect(str).toContain("Hello world")
    expect(str).not.toContain("DOCTYPE")
    expect(str).not.toContain("font-family")
    expect(str).not.toContain("mermaid.initialize")
  })

  it("returns array of Telegraph Node objects", () => {
    // Arrange
    const html = wrapInFullHtml("<p>Text</p>")

    // Act
    const result = toTelegraphContent(html)

    // Assert
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  it("replaces mermaid pre blocks with kroki img nodes", () => {
    // Arrange
    const mermaidContent = "classDiagram\n    class Foo {\n        +bar() string\n    }"
    const escaped = mermaidContent
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
    const html = wrapInFullHtml(`<pre class="mermaid">${escaped}</pre>`)

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    expect(str).toContain("kroki.io/plantuml/svg/")
    expect(str).toContain("\"tag\":\"img\"")
    expect(str).not.toContain("\"tag\":\"pre\"")
  })

  it("downgrades h1 and h2 to h3", () => {
    // Arrange
    const html = wrapInFullHtml("<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>")

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    expect(str).toContain("\"tag\":\"h3\"")
    expect(str).toContain("Title")
    expect(str).toContain("Subtitle")
    expect(str).toContain("Section")
    expect(str).not.toContain("\"tag\":\"h1\"")
    expect(str).not.toContain("\"tag\":\"h2\"")
  })

  it("downgrades h5 and h6 to h4", () => {
    // Arrange
    const html = wrapInFullHtml("<h5>Small</h5><h6>Tiny</h6><h4>Normal</h4>")

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    expect(str).toContain("\"tag\":\"h4\"")
    expect(str).toContain("Small")
    expect(str).toContain("Tiny")
    expect(str).toContain("Normal")
    expect(str).not.toContain("\"tag\":\"h5\"")
    expect(str).not.toContain("\"tag\":\"h6\"")
  })

  it("handles multiple mermaid blocks", () => {
    // Arrange
    const block1 = "classDiagram\n    class A {\n        +foo() void\n    }"
    const block2 = "classDiagram\n    class B {\n        +bar() void\n    }"
    const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    const html = wrapInFullHtml(
      `<pre class="mermaid">${escape(block1)}</pre><p>Text between</p><pre class="mermaid">${escape(block2)}</pre>`
    )

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    const imgCount = (str.match(/"tag":"img"/g) ?? []).length
    expect(imgCount).toBe(2)
    expect(str).toContain("Text between")
  })

  it("unescapes HTML entities in mermaid content before conversion", () => {
    // Arrange
    const mermaidRaw = "classDiagram\n    class Gist {\n        +files Record~string, RawUrl~\n    }"
    const escaped = mermaidRaw
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
    const html = wrapInFullHtml(`<pre class="mermaid">${escaped}</pre>`)

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    expect(str).toContain("kroki.io/plantuml/svg/")
    expect(str).not.toContain("\"tag\":\"pre\"")
  })

  it("falls back to full input when no body tag found", () => {
    // Arrange
    const html = "<h2>No body wrapper</h2><p>Content</p>"

    // Act
    const result = toTelegraphContent(html)

    // Assert
    const str = stringify(result)
    expect(str).toContain("No body wrapper")
    expect(str).toContain("Content")
  })
})
