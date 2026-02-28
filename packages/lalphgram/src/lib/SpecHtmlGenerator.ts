/**
 * Generates a self-contained HTML page from spec files, with Mermaid.js
 * CDN for client-side diagram rendering.
 * @since 1.0.0
 */

export interface SpecFile {
  readonly name: string
  readonly content: string
  readonly mermaid: boolean
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")

const markdownToHtml = (text: string): string => {
  const placeholders: Array<readonly [string, string]> = []
  let counter = 0

  const makePlaceholder = (htmlContent: string): string => {
    const key = `\x00PH${counter}\x00`
    counter++
    placeholders.push([key, htmlContent])
    return key
  }

  // Extract fenced code blocks
  let result = text.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_, lang: string | undefined, code: string) => {
      const escaped = escapeHtml(code)
      if (lang) {
        return makePlaceholder(
          `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        )
      }
      return makePlaceholder(`<pre><code>${escaped}</code></pre>`)
    }
  )

  // Extract inline code
  result = result.replace(
    /`([^`\n]+)`/g,
    (_, code: string) => makePlaceholder(`<code>${escapeHtml(code)}</code>`)
  )

  // HTML-escape remaining text
  result = escapeHtml(result)

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>")

  // Italic: *text*
  result = result.replace(/\*(\S.*?\S|\S)\*/g, "<em>$1</em>")
  result = result.replace(/(?<!\w)_(\S.*?\S|\S)_(?!\w)/g, "<em>$1</em>")

  // Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    "<a href=\"$2\">$1</a>"
  )

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>")

  // Horizontal rules: --- or *** or ___ on their own line
  result = result.replace(/^(?:---|\*\*\*|___)$/gm, "<hr>")

  // Process block-level elements line by line
  const lines = result.split("\n")
  const output: Array<string> = []
  let inList = false

  for (const line of lines) {
    // Headers: # Header
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headerMatch?.[1] && headerMatch[2]) {
      if (inList) {
        output.push("</ul>")
        inList = false
      }
      const level = headerMatch[1].length
      output.push(`<h${level}>${headerMatch[2]}</h${level}>`)
      continue
    }

    // Unordered list items: - item or * item
    const listMatch = /^[-*]\s+(.+)$/.exec(line)
    if (listMatch?.[1]) {
      if (!inList) {
        output.push("<ul>")
        inList = true
      }
      output.push(`<li>${listMatch[1]}</li>`)
      continue
    }

    // Close list if we hit a non-list line
    if (inList) {
      output.push("</ul>")
      inList = false
    }

    // Skip <hr> — already converted
    if (line === "<hr>") {
      output.push(line)
      continue
    }

    // Empty lines
    if (line.trim() === "") {
      output.push("")
      continue
    }

    // Regular paragraph
    output.push(`<p>${line}</p>`)
  }

  if (inList) {
    output.push("</ul>")
  }

  result = output.join("\n")

  // Restore placeholders
  for (const [key, htmlContent] of placeholders) {
    result = result.replace(key, htmlContent)
  }

  return result
}

const renderFileSection = (file: SpecFile): string => {
  const heading = `<h2>${escapeHtml(file.name)}</h2>`
  if (file.mermaid) {
    return `${heading}\n<pre class="mermaid">${escapeHtml(file.content)}</pre>`
  }
  return `${heading}\n${markdownToHtml(file.content)}`
}

/**
 * Generate a self-contained HTML page from spec files.
 * Mermaid files are wrapped in `<pre class="mermaid">` for client-side rendering.
 * Markdown files are converted to basic HTML.
 * @since 1.0.0
 */
export const generateSpecHtml = (files: ReadonlyArray<SpecFile>): string => {
  const sections = files.map(renderFileSection).join("\n\n")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spec Files</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 1rem;
      line-height: 1.6;
      color: #333;
    }
    pre {
      background: #f5f5f5;
      padding: 1rem;
      overflow-x: auto;
      border-radius: 4px;
    }
    code {
      background: #f0f0f0;
      padding: 0.15em 0.3em;
      border-radius: 3px;
      font-size: 0.9em;
    }
    pre code {
      background: none;
      padding: 0;
    }
    h2 {
      border-bottom: 1px solid #eee;
      padding-bottom: 0.3em;
    }
  </style>
</head>
<body>
${sections}
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`
}
