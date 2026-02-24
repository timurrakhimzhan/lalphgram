import { describe, expect, it } from "@effect/vitest"
import type { Node } from "better-telegraph"
import type { SpecFile } from "../src/lib/SpecHtmlGenerator.js"
import { markdownToTelegraphNodes, specFilesToTelegraphNodes } from "../src/lib/TelegraphMarkdown.js"

const stringify = (nodes: ReadonlyArray<Node>): string => JSON.stringify(nodes)

const findByTag = (nodes: ReadonlyArray<Node>, tag: string): ReadonlyArray<Node> =>
  nodes.filter((n): n is Exclude<Node, string> => typeof n !== "string" && n.tag === tag)

describe("markdownToTelegraphNodes", () => {
  describe("headings", () => {
    it("maps h1 to h3", () => {
      // Arrange
      const md = "# Title"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"h3\"")
      expect(str).toContain("Title")
    })

    it("maps h2 to h3", () => {
      // Arrange
      const md = "## Subtitle"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"h3\"")
      expect(str).toContain("Subtitle")
    })

    it("maps h3 to h4", () => {
      // Arrange
      const md = "### Section"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"h4\"")
      expect(str).toContain("Section")
    })

    it("maps h4 through h6 to h4", () => {
      // Arrange
      const md = "#### Four\n##### Five\n###### Six"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).not.toContain("\"tag\":\"h5\"")
      expect(str).not.toContain("\"tag\":\"h6\"")
      expect(findByTag(result, "h4")).toHaveLength(3)
    })

    it("does not produce h1 or h2 tags", () => {
      // Arrange
      const md = "# H1\n## H2\n### H3"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).not.toContain("\"tag\":\"h1\"")
      expect(str).not.toContain("\"tag\":\"h2\"")
    })
  })

  describe("paragraphs", () => {
    it("wraps text in p tag", () => {
      // Arrange
      const md = "Hello world"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "p", children: ["Hello world"] }])
    })

    it("joins continuation lines with space", () => {
      // Arrange
      const md = "Line one\nLine two"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "p", children: ["Line one Line two"] }])
    })

    it("splits paragraphs on blank lines", () => {
      // Arrange
      const md = "First para\n\nSecond para"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(findByTag(result, "p")).toHaveLength(2)
    })
  })

  describe("code blocks", () => {
    it("creates pre > code structure", () => {
      // Arrange
      const md = "```\nconst x = 1\n```"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([
        { tag: "pre", children: [{ tag: "code", children: ["const x = 1"] }] }
      ])
    })

    it("preserves language annotation (no effect on output)", () => {
      // Arrange
      const md = "```typescript\nconst x: number = 1\n```"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([
        { tag: "pre", children: [{ tag: "code", children: ["const x: number = 1"] }] }
      ])
    })

    it("does not parse inline markdown inside code blocks", () => {
      // Arrange
      const md = "```\n**bold** and *italic* and `code`\n```"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).not.toContain("\"tag\":\"strong\"")
      expect(str).not.toContain("\"tag\":\"em\"")
      expect(str).toContain("**bold** and *italic* and `code`")
    })

    it("preserves multi-line code", () => {
      // Arrange
      const md = "```\nline 1\nline 2\nline 3\n```"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([
        { tag: "pre", children: [{ tag: "code", children: ["line 1\nline 2\nline 3"] }] }
      ])
    })
  })

  describe("unordered lists", () => {
    it("creates ul with li children using dash syntax", () => {
      // Arrange
      const md = "- item one\n- item two"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{
        tag: "ul",
        children: [
          { tag: "li", children: ["item one"] },
          { tag: "li", children: ["item two"] }
        ]
      }])
    })

    it("creates ul with li children using asterisk syntax", () => {
      // Arrange
      const md = "* first\n* second"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{
        tag: "ul",
        children: [
          { tag: "li", children: ["first"] },
          { tag: "li", children: ["second"] }
        ]
      }])
    })

    it("parses inline formatting inside list items", () => {
      // Arrange
      const md = "- **bold item**\n- `code item`"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"strong\"")
      expect(str).toContain("\"tag\":\"code\"")
    })
  })

  describe("ordered lists", () => {
    it("creates ol with li children", () => {
      // Arrange
      const md = "1. first\n2. second\n3. third"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{
        tag: "ol",
        children: [
          { tag: "li", children: ["first"] },
          { tag: "li", children: ["second"] },
          { tag: "li", children: ["third"] }
        ]
      }])
    })
  })

  describe("blockquotes", () => {
    it("creates blockquote node", () => {
      // Arrange
      const md = "> quoted text"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "blockquote", children: ["quoted text"] }])
    })

    it("joins multi-line blockquotes", () => {
      // Arrange
      const md = "> line one\n> line two"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "blockquote", children: ["line one line two"] }])
    })
  })

  describe("horizontal rules", () => {
    it("converts --- to hr", () => {
      // Arrange
      const md = "---"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "hr" }])
    })

    it("converts *** to hr", () => {
      // Arrange
      const md = "***"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "hr" }])
    })

    it("converts ___ to hr", () => {
      // Arrange
      const md = "___"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([{ tag: "hr" }])
    })
  })

  describe("inline formatting", () => {
    it("parses bold with double asterisks", () => {
      // Arrange
      const md = "some **bold** text"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"strong\"")
      expect(str).toContain("bold")
    })

    it("parses bold with double underscores", () => {
      // Arrange
      const md = "some __bold__ text"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"strong\"")
    })

    it("parses italic with single asterisk", () => {
      // Arrange
      const md = "some *italic* text"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"em\"")
      expect(str).toContain("italic")
    })

    it("parses italic with single underscore", () => {
      // Arrange
      const md = "some _italic_ text"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"em\"")
    })

    it("parses inline code", () => {
      // Arrange
      const md = "use `Effect.gen` here"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"code\"")
      expect(str).toContain("Effect.gen")
    })

    it("parses links", () => {
      // Arrange
      const md = "visit [Example](https://example.com) now"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"a\"")
      expect(str).toContain("\"href\":\"https://example.com\"")
      expect(str).toContain("Example")
    })

    it("parses strikethrough", () => {
      // Arrange
      const md = "this is ~~deleted~~ text"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"s\"")
      expect(str).toContain("deleted")
    })

    it("handles nested bold inside italic", () => {
      // Arrange
      const md = "text with **bold and `code`** here"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).toContain("\"tag\":\"strong\"")
      expect(str).toContain("\"tag\":\"code\"")
    })
  })

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      // Arrange
      const md = ""

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([])
    })

    it("returns empty array for whitespace-only input", () => {
      // Arrange
      const md = "   \n   \n   "

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      expect(result).toEqual([])
    })

    it("handles code block containing markdown syntax", () => {
      // Arrange
      const md = "```\n# Not a heading\n**Not bold**\n- Not a list\n```"

      // Act
      const result = markdownToTelegraphNodes(md)

      // Assert
      const str = stringify(result)
      expect(str).not.toContain("\"tag\":\"h3\"")
      expect(str).not.toContain("\"tag\":\"h4\"")
      expect(str).not.toContain("\"tag\":\"strong\"")
      expect(str).not.toContain("\"tag\":\"ul\"")
      expect(str).toContain("# Not a heading")
    })
  })
})

describe("specFilesToTelegraphNodes", () => {
  it("adds file name as h3 heading for each file", () => {
    // Arrange
    const files: ReadonlyArray<SpecFile> = [
      { name: "analysis.md", content: "Some content", mermaid: false }
    ]

    // Act
    const result = specFilesToTelegraphNodes(files)

    // Assert
    const str = stringify(result)
    expect(str).toContain("\"tag\":\"h3\"")
    expect(str).toContain("analysis.md")
  })

  it("converts mermaid files to kroki img nodes", () => {
    // Arrange
    const files: ReadonlyArray<SpecFile> = [{
      name: "services.mmd",
      content: "classDiagram\n    class Foo {\n        +bar() string\n    }",
      mermaid: true
    }]

    // Act
    const result = specFilesToTelegraphNodes(files)

    // Assert
    const str = stringify(result)
    expect(str).toContain("kroki.io/plantuml/svg/")
    expect(str).toContain("\"tag\":\"img\"")
  })

  it("converts markdown files to Telegraph nodes", () => {
    // Arrange
    const files: ReadonlyArray<SpecFile> = [
      { name: "test.md", content: "## Overview\n\nSome text", mermaid: false }
    ]

    // Act
    const result = specFilesToTelegraphNodes(files)

    // Assert
    const str = stringify(result)
    expect(str).toContain("\"tag\":\"h3\"")
    expect(str).toContain("Overview")
    expect(str).toContain("Some text")
  })

  it("handles multiple files in order", () => {
    // Arrange
    const files: ReadonlyArray<SpecFile> = [
      { name: "first.md", content: "First content", mermaid: false },
      { name: "second.md", content: "Second content", mermaid: false }
    ]

    // Act
    const result = specFilesToTelegraphNodes(files)

    // Assert
    const str = stringify(result)
    const firstIdx = str.indexOf("first.md")
    const secondIdx = str.indexOf("second.md")
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(str).toContain("First content")
    expect(str).toContain("Second content")
  })

  it("handles mixed markdown and mermaid files", () => {
    // Arrange
    const files: ReadonlyArray<SpecFile> = [
      { name: "analysis.md", content: "# Feature\n\nDescription here", mermaid: false },
      { name: "services.mmd", content: "classDiagram\n    class A {\n        +foo() void\n    }", mermaid: true },
      { name: "test.md", content: "Test plan details", mermaid: false }
    ]

    // Act
    const result = specFilesToTelegraphNodes(files)

    // Assert
    const str = stringify(result)
    expect(str).toContain("analysis.md")
    expect(str).toContain("Feature")
    expect(str).toContain("kroki.io/plantuml/svg/")
    expect(str).toContain("test.md")
    expect(str).toContain("Test plan details")
  })
})
