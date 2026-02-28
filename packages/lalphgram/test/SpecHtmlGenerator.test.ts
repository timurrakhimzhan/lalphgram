import { describe, expect, it } from "@effect/vitest"
import { generateSpecHtml } from "../src/lib/SpecHtmlGenerator.js"

describe("generateSpecHtml", () => {
  it("generates valid HTML with doctype, head, and body", () => {
    // Arrange
    const files = [{ name: "test.md", content: "hello", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("<html")
    expect(html).toContain("<head>")
    expect(html).toContain("<meta charset")
    expect(html).toContain("<meta name=\"viewport\"")
    expect(html).toContain("</head>")
    expect(html).toContain("<body>")
    expect(html).toContain("</body>")
    expect(html).toContain("</html>")
  })

  it("includes Mermaid.js CDN script", () => {
    // Arrange
    const files = [{ name: "test.md", content: "hello", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("cdn.jsdelivr.net/npm/mermaid@11")
    expect(html).toContain("mermaid.initialize")
  })

  it("renders markdown file with heading for file name", () => {
    // Arrange
    const files = [{ name: "analysis.md", content: "Design summary", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<h2>analysis.md</h2>")
    expect(html).toContain("Design summary")
  })

  it("wraps mermaid content in pre.mermaid", () => {
    // Arrange
    const files = [{ name: "services.mmd", content: "classDiagram\nclass Foo", mermaid: true }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<pre class=\"mermaid\">")
    expect(html).toContain("classDiagram\nclass Foo")
  })

  it("renders multiple files in order", () => {
    // Arrange
    const files = [
      { name: "analysis.md", content: "First file", mermaid: false },
      { name: "services.mmd", content: "classDiagram", mermaid: true },
      { name: "test.md", content: "Third file", mermaid: false }
    ]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    const analysisIdx = html.indexOf("<h2>analysis.md</h2>")
    const servicesIdx = html.indexOf("<h2>services.mmd</h2>")
    const testIdx = html.indexOf("<h2>test.md</h2>")
    expect(analysisIdx).toBeLessThan(servicesIdx)
    expect(servicesIdx).toBeLessThan(testIdx)
  })

  it("escapes HTML entities in content", () => {
    // Arrange
    const files = [{ name: "test.md", content: "<script>alert('xss')</script> & \"quotes\"", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&amp;")
  })

  it("escapes HTML entities in mermaid content", () => {
    // Arrange
    const files = [{ name: "test.mmd", content: "A --> B : <tag>", mermaid: true }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("&lt;tag&gt;")
  })

  it("converts markdown headers to HTML", () => {
    // Arrange
    const files = [{ name: "test.md", content: "# Main Title\n## Subtitle\nParagraph", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<h1>Main Title</h1>")
    expect(html).toContain("<h2>Subtitle</h2>")
    expect(html).toContain("<p>Paragraph</p>")
  })

  it("converts markdown bold and italic", () => {
    // Arrange
    const files = [{ name: "test.md", content: "**bold** and *italic* text", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<em>italic</em>")
  })

  it("converts markdown code blocks", () => {
    // Arrange
    const files = [{ name: "test.md", content: "```typescript\nconst x = 1\n```", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<pre><code")
    expect(html).toContain("const x = 1")
  })

  it("converts inline code", () => {
    // Arrange
    const files = [{ name: "test.md", content: "Use `Effect.gen` here", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<code>Effect.gen</code>")
  })

  it("converts markdown links", () => {
    // Arrange
    const files = [{ name: "test.md", content: "[Click here](https://example.com)", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<a href=\"https://example.com\">Click here</a>")
  })

  it("converts unordered lists", () => {
    // Arrange
    const files = [{ name: "test.md", content: "- item one\n- item two\n- item three", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<ul>")
    expect(html).toContain("<li>item one</li>")
    expect(html).toContain("<li>item two</li>")
    expect(html).toContain("</ul>")
  })

  it("converts horizontal rules", () => {
    // Arrange
    const files = [{ name: "test.md", content: "above\n\n---\n\nbelow", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<hr>")
  })

  it("includes style block with basic styling", () => {
    // Arrange
    const files = [{ name: "test.md", content: "hello", mermaid: false }]

    // Act
    const html = generateSpecHtml(files)

    // Assert
    expect(html).toContain("<style>")
    expect(html).toContain("max-width")
    expect(html).toContain("</style>")
  })
})
