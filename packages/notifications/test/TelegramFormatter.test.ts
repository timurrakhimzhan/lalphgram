import { describe, expect, it } from "@effect/vitest"
import { markdownToTelegramHtml, splitMessage } from "../src/lib/TelegramFormatter.js"

describe("markdownToTelegramHtml", () => {
  describe("fenced code blocks", () => {
    it("converts fenced code blocks with language", () => {
      // Arrange
      const input = "```typescript\nconst x = 1\n```"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe(
        "<pre><code class=\"language-typescript\">const x = 1\n</code></pre>"
      )
    })

    it("converts fenced code blocks without language", () => {
      // Arrange
      const input = "```\nsome code\n```"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("<pre><code>some code\n</code></pre>")
    })

    it("escapes HTML inside code blocks", () => {
      // Arrange
      const input = "```\n<div>hello & world</div>\n```"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe(
        "<pre><code>&lt;div&gt;hello &amp; world&lt;/div&gt;\n</code></pre>"
      )
    })
  })

  describe("inline code", () => {
    it("converts inline code", () => {
      // Arrange
      const input = "Use `Effect.gen` for generators"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("Use <code>Effect.gen</code> for generators")
    })

    it("escapes HTML inside inline code", () => {
      // Arrange
      const input = "Use `Array<string>` for types"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("Use <code>Array&lt;string&gt;</code> for types")
    })
  })

  describe("bold", () => {
    it("converts **text** to bold", () => {
      // Arrange
      const input = "This is **bold** text"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("This is <b>bold</b> text")
    })

    it("converts __text__ to bold", () => {
      // Arrange
      const input = "This is __bold__ text"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("This is <b>bold</b> text")
    })
  })

  describe("italic", () => {
    it("converts *text* to italic", () => {
      // Arrange
      const input = "This is *italic* text"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("This is <i>italic</i> text")
    })

    it("converts _text_ to italic at word boundaries", () => {
      // Arrange
      const input = "This is _italic_ text"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("This is <i>italic</i> text")
    })

    it("does not convert underscores inside words", () => {
      // Arrange
      const input = "my_var_name stays"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("my_var_name stays")
    })
  })

  describe("links", () => {
    it("converts markdown links to HTML", () => {
      // Arrange
      const input = "See [Effect docs](https://effect.website)"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("See <a href=\"https://effect.website\">Effect docs</a>")
    })
  })

  describe("headers", () => {
    it("converts h1 headers to bold", () => {
      // Arrange
      const input = "# Main Title"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("<b>Main Title</b>")
    })

    it("converts h3 headers to bold", () => {
      // Arrange
      const input = "### Subsection"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("<b>Subsection</b>")
    })

    it("converts headers in multiline text", () => {
      // Arrange
      const input = "Intro\n## Title\nBody"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("Intro\n<b>Title</b>\nBody")
    })
  })

  describe("strikethrough", () => {
    it("converts ~~text~~ to strikethrough", () => {
      // Arrange
      const input = "This is ~~deleted~~ text"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("This is <s>deleted</s> text")
    })
  })

  describe("HTML escaping", () => {
    it("escapes < > & in plain text", () => {
      // Arrange
      const input = "x < 10 && y > 5"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toBe("x &lt; 10 &amp;&amp; y &gt; 5")
    })
  })

  describe("mixed content", () => {
    it("handles code blocks alongside markdown formatting", () => {
      // Arrange
      const input = "# Title\n\n**Bold** and *italic*\n\n```ts\nconst x = 1\n```"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).toContain("<b>Title</b>")
      expect(result).toContain("<b>Bold</b>")
      expect(result).toContain("<i>italic</i>")
      expect(result).toContain("<pre><code class=\"language-ts\">const x = 1\n</code></pre>")
    })

    it("does not apply markdown inside code blocks", () => {
      // Arrange
      const input = "```\n**not bold** and *not italic*\n```"

      // Act
      const result = markdownToTelegramHtml(input)

      // Assert
      expect(result).not.toContain("<b>")
      expect(result).not.toContain("<i>")
      expect(result).toContain("**not bold** and *not italic*")
    })
  })
})

describe("splitMessage", () => {
  it("returns text as-is when under limit", () => {
    // Arrange
    const input = "Short message"

    // Act
    const result = splitMessage(input)

    // Assert
    expect(result).toEqual(["Short message"])
  })

  it("splits on paragraph boundaries", () => {
    // Arrange
    const para1 = "A".repeat(3000)
    const para2 = "B".repeat(3000)
    const input = `${para1}\n\n${para2}`

    // Act
    const result = splitMessage(input)

    // Assert
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(para1)
    expect(result[1]).toBe(para2)
  })

  it("splits long paragraphs on line boundaries", () => {
    // Arrange
    const line1 = "A".repeat(3000)
    const line2 = "B".repeat(3000)
    const input = `${line1}\n${line2}`

    // Act
    const result = splitMessage(input)

    // Assert
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(line1)
    expect(result[1]).toBe(line2)
  })

  it("respects custom maxLen", () => {
    // Arrange
    const input = "Hello\n\nWorld"

    // Act
    const result = splitMessage(input, 6)

    // Assert
    expect(result).toEqual(["Hello", "World"])
  })
})
