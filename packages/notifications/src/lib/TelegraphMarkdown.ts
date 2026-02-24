/**
 * Converts markdown directly to Telegraph Node array.
 * Two-phase parser: block-level state machine + recursive inline scanner.
 * Skips the lossy HTML intermediate step for better fidelity.
 * @since 1.0.0
 */
import type { Node } from "better-telegraph"
import { deflateSync } from "node:zlib"
import { mermaidToPlantUml } from "./MermaidToPlantUml.js"
import type { SpecFile } from "./SpecHtmlGenerator.js"

// ---------------------------------------------------------------------------
// Block types
// ---------------------------------------------------------------------------

type Block =
  | { readonly _tag: "codeBlock"; readonly lang: string | undefined; readonly code: string }
  | { readonly _tag: "heading"; readonly level: number; readonly text: string }
  | { readonly _tag: "hr" }
  | { readonly _tag: "unorderedList"; readonly items: ReadonlyArray<string> }
  | { readonly _tag: "orderedList"; readonly items: ReadonlyArray<string> }
  | { readonly _tag: "blockquote"; readonly text: string }
  | { readonly _tag: "paragraph"; readonly text: string }

// ---------------------------------------------------------------------------
// Block-level parser
// ---------------------------------------------------------------------------

const isBlockStart = (line: string): boolean =>
  /^#{1,6}\s/.test(line) ||
  /^[-*]\s+/.test(line) ||
  /^\d+\.\s+/.test(line) ||
  /^>/.test(line) ||
  /^```/.test(line) ||
  /^(?:---+|\*\*\*+|___+)\s*$/.test(line)

const parseBlocks = (markdown: string): ReadonlyArray<Block> => {
  const lines = markdown.split("\n")
  const blocks: Array<Block> = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""

    // Code fence
    const fenceMatch = /^```(\w*)/.exec(line)
    if (fenceMatch) {
      const lang = fenceMatch[1] || undefined
      const codeLines: Array<string> = []
      i++
      while (i < lines.length) {
        const codeLine = lines[i] ?? ""
        if (/^```\s*$/.test(codeLine)) break
        codeLines.push(codeLine)
        i++
      }
      blocks.push({ _tag: "codeBlock", lang, code: codeLines.join("\n") })
      if (i < lines.length) i++ // skip closing ```
      continue
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      const hashes = headingMatch[1] ?? "#"
      const text = headingMatch[2] ?? ""
      blocks.push({ _tag: "heading", level: hashes.length, text })
      i++
      continue
    }

    // HR (must come before list check since *** could look like a list start)
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ _tag: "hr" })
      i++
      continue
    }

    // Unordered list
    const ulMatch = /^[-*]\s+(.+)$/.exec(line)
    if (ulMatch) {
      const items: Array<string> = [ulMatch[1] ?? ""]
      i++
      while (i < lines.length) {
        const nextLine = lines[i] ?? ""
        const nextMatch = /^[-*]\s+(.+)$/.exec(nextLine)
        if (!nextMatch) break
        items.push(nextMatch[1] ?? "")
        i++
      }
      blocks.push({ _tag: "unorderedList", items })
      continue
    }

    // Ordered list
    const olMatch = /^\d+\.\s+(.+)$/.exec(line)
    if (olMatch) {
      const items: Array<string> = [olMatch[1] ?? ""]
      i++
      while (i < lines.length) {
        const nextLine = lines[i] ?? ""
        const nextMatch = /^\d+\.\s+(.+)$/.exec(nextLine)
        if (!nextMatch) break
        items.push(nextMatch[1] ?? "")
        i++
      }
      blocks.push({ _tag: "orderedList", items })
      continue
    }

    // Blockquote
    const bqMatch = /^>\s?(.*)$/.exec(line)
    if (bqMatch) {
      const bqLines: Array<string> = [bqMatch[1] ?? ""]
      i++
      while (i < lines.length) {
        const nextLine = lines[i] ?? ""
        const nextBq = /^>\s?(.*)$/.exec(nextLine)
        if (!nextBq) break
        bqLines.push(nextBq[1] ?? "")
        i++
      }
      blocks.push({ _tag: "blockquote", text: bqLines.join(" ") })
      continue
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++
      continue
    }

    // Paragraph — accumulate non-blank, non-block-start lines
    const paraLines: Array<string> = [line]
    i++
    while (i < lines.length) {
      const nextLine = lines[i] ?? ""
      if (nextLine.trim() === "" || isBlockStart(nextLine)) break
      paraLines.push(nextLine)
      i++
    }
    blocks.push({ _tag: "paragraph", text: paraLines.join(" ") })
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Inline parser — "find earliest match" recursive scanner
// ---------------------------------------------------------------------------

const inlinePatterns = [
  { type: "code", regex: /`([^`]+)`/ },
  { type: "link", regex: /\[([^\]]+)\]\(([^)]+)\)/ },
  { type: "bold_star", regex: /\*\*(.+?)\*\*/ },
  { type: "bold_under", regex: /__(.+?)__/ },
  { type: "strike", regex: /~~(.+?)~~/ },
  { type: "italic_star", regex: /(?<![*])\*(?!\*)(.+?)(?<![*])\*(?!\*)/ },
  { type: "italic_under", regex: /(?<!\w)_(.+?)_(?!\w)/ }
] as const

const parseInline = (text: string): Array<Node> => {
  if (text === "") return []

  const nodes: Array<Node> = []
  let remaining = text

  while (remaining.length > 0) {
    let earliestIndex = remaining.length
    let earliestType: string | undefined
    let earliestMatch: RegExpExecArray | undefined

    for (const { regex, type } of inlinePatterns) {
      const match = regex.exec(remaining)
      if (match && match.index < earliestIndex) {
        earliestIndex = match.index
        earliestType = type
        earliestMatch = match
      }
    }

    if (!earliestMatch || !earliestType) {
      nodes.push(remaining)
      break
    }

    // Text before the match
    if (earliestIndex > 0) {
      nodes.push(remaining.slice(0, earliestIndex))
    }

    const group1 = earliestMatch[1] ?? ""
    const group2 = earliestMatch[2] ?? ""

    switch (earliestType) {
      case "code":
        nodes.push({ tag: "code", children: [group1] })
        break
      case "link":
        nodes.push({ tag: "a", attrs: { href: group2 }, children: parseInline(group1) })
        break
      case "bold_star":
      case "bold_under":
        nodes.push({ tag: "strong", children: parseInline(group1) })
        break
      case "italic_star":
      case "italic_under":
        nodes.push({ tag: "em", children: parseInline(group1) })
        break
      case "strike":
        nodes.push({ tag: "s", children: parseInline(group1) })
        break
    }

    remaining = remaining.slice(earliestIndex + earliestMatch[0].length)
  }

  return nodes
}

// ---------------------------------------------------------------------------
// Block → Node conversion
// ---------------------------------------------------------------------------

const blockToNodes = (block: Block): Array<Node> => {
  switch (block._tag) {
    case "codeBlock":
      return [{ tag: "pre", children: [{ tag: "code", children: [block.code] }] }]
    case "heading": {
      const tag = block.level <= 2 ? "h3" : "h4"
      return [{ tag, children: parseInline(block.text) }]
    }
    case "hr":
      return [{ tag: "hr" }]
    case "unorderedList":
      return [{ tag: "ul", children: block.items.map((item) => ({ tag: "li" as const, children: parseInline(item) })) }]
    case "orderedList":
      return [{ tag: "ol", children: block.items.map((item) => ({ tag: "li" as const, children: parseInline(item) })) }]
    case "blockquote":
      return [{ tag: "blockquote", children: parseInline(block.text) }]
    case "paragraph":
      return [{ tag: "p", children: parseInline(block.text) }]
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a markdown string directly to Telegraph Node array.
 * @since 1.0.0
 */
export const markdownToTelegraphNodes = (md: string): ReadonlyArray<Node> => parseBlocks(md).flatMap(blockToNodes)

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
 * Convert spec files to Telegraph Node array.
 * Adds file name as h3 heading per file.
 * Mermaid files become kroki.io PlantUML SVG images.
 * @since 1.0.0
 */
export const specFilesToTelegraphNodes = (files: ReadonlyArray<SpecFile>): ReadonlyArray<Node> => {
  const nodes: Array<Node> = []
  for (const file of files) {
    nodes.push({ tag: "h3", children: [file.name] })

    if (file.mermaid) {
      const url = mermaidToKrokiUrl(file.content)
      nodes.push({ tag: "img", attrs: { src: url } })
    } else {
      for (const node of markdownToTelegraphNodes(file.content)) {
        nodes.push(node)
      }
    }
  }
  return nodes
}
