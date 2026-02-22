/**
 * Markdown-to-Telegram-HTML converter.
 *
 * Telegram supports a narrow HTML subset: `<b>`, `<i>`, `<code>`, `<pre>`,
 * `<a href>`, `<s>`. This module converts common markdown patterns to that
 * subset while preserving code blocks verbatim.
 *
 * Ported from `repos/claude-code-telegram/src/bot/utils/html_format.py`.
 * @since 1.0.0
 */

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

/**
 * Convert markdown text to Telegram-compatible HTML.
 *
 * Order of operations:
 * 1. Extract fenced code blocks → placeholders
 * 2. Extract inline code → placeholders
 * 3. HTML-escape remaining text
 * 4. Bold (`**text**` / `__text__`)
 * 5. Italic (`*text*`, `_text_` at word boundaries)
 * 6. Links (`[text](url)`)
 * 7. Headers (`# Header` → `<b>Header</b>`)
 * 8. Strikethrough (`~~text~~`)
 * 9. Restore placeholders
 * @since 1.0.0
 */
export const markdownToTelegramHtml = (text: string): string => {
  const placeholders: Array<readonly [string, string]> = []
  let counter = 0

  const makePlaceholder = (htmlContent: string): string => {
    const key = `\x00PH${counter}\x00`
    counter++
    placeholders.push([key, htmlContent])
    return key
  }

  // 1. Extract fenced code blocks
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

  // 2. Extract inline code
  result = result.replace(
    /`([^`\n]+)`/g,
    (_, code: string) => makePlaceholder(`<code>${escapeHtml(code)}</code>`)
  )

  // 3. HTML-escape remaining text
  result = escapeHtml(result)

  // 4. Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  result = result.replace(/__(.+?)__/g, "<b>$1</b>")

  // 5. Italic: *text* (non-space bounded)
  result = result.replace(/\*(\S.*?\S|\S)\*/g, "<i>$1</i>")
  // _text_ only at word boundaries (avoid my_var_name)
  result = result.replace(/(?<!\w)_(\S.*?\S|\S)_(?!\w)/g, "<i>$1</i>")

  // 6. Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    "<a href=\"$2\">$1</a>"
  )

  // 7. Headers: # Header -> <b>Header</b>
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")

  // 8. Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>")

  // 9. Restore placeholders
  for (const [key, htmlContent] of placeholders) {
    result = result.replace(key, htmlContent)
  }

  return result
}

/**
 * Split a message into chunks that fit within Telegram's message size limit.
 *
 * Splits on `\n\n` boundaries first; if a single paragraph still exceeds the
 * limit, splits on `\n`.
 * @since 1.0.0
 */
export const splitMessage = (
  text: string,
  maxLen: number = 4096
): ReadonlyArray<string> => {
  if (text.length <= maxLen) {
    return [text]
  }

  const chunks: Array<string> = []
  const paragraphs = text.split("\n\n")
  let current = ""

  for (const para of paragraphs) {
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`

    if (candidate.length <= maxLen) {
      current = candidate
    } else {
      if (current.length > 0) {
        chunks.push(current)
        current = ""
      }

      // If the paragraph itself exceeds maxLen, split on \n
      if (para.length > maxLen) {
        const lines = para.split("\n")
        for (const line of lines) {
          const lineCandidate = current.length === 0 ? line : `${current}\n${line}`
          if (lineCandidate.length <= maxLen) {
            current = lineCandidate
          } else {
            if (current.length > 0) {
              chunks.push(current)
            }
            current = line
          }
        }
      } else {
        current = para
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current)
  }

  return chunks
}
