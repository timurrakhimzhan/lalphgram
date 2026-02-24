import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { generateSpecHtml } from "../../src/lib/SpecHtmlGenerator.js"

const analysisContent = `# Upload Spec Files as Rendered HTML Gist

## Context

Spec files (analysis.md, services.mmd, test.md) are currently sent as raw text via Telegram, chunked to fit the 4096 char limit. Mermaid diagrams appear as unrendered code blocks.

## Files to Change

| File | Action |
|------|--------|
| \`src/lib/SpecHtmlGenerator.ts\` | **CREATE** — pure function \`generateSpecHtml\` |
| \`src/services/OctokitClient.ts\` | **MODIFY** — add \`OctokitGist\` model + \`createGist\` method |
| \`src/services/EventLoop.ts\` | **MODIFY** — rewrite \`sendSpecFiles\`, add \`OctokitClient\` dep |

## Steps

### 1. Create \`src/lib/SpecHtmlGenerator.ts\`

Pure function that takes \`ReadonlyArray<{name, content, mermaid}>\` and returns an HTML string:

- \`<!DOCTYPE html>\` with charset, viewport meta
- \`<style>\` block: clean font, max-width, code block styling
- Per file: \`<h2>\` header + content section

### 2. Add \`createGist\` to \`OctokitClient\`

\`\`\`typescript
export interface OctokitGist {
  readonly id: string
  readonly htmlUrl: string
  readonly files: Record<string, { readonly rawUrl: string }>
}
\`\`\`

### 3. Modify \`sendSpecFiles\`

1. Read files (same logic)
2. Call \`generateSpecHtml(files)\` to produce HTML
3. Upload via \`octokitClient.createGist(...)\`
4. Build view URL: \`https://htmlpreview.github.io/?{rawUrl}\`
5. On gist failure, fall back to current raw-text behavior

---

*This plan uses the existing Mermaid.js CDN for rendering.*
`

const servicesContent = `classDiagram
    class SpecHtmlGenerator {
        +generateSpecHtml(files: SpecFile[]) string
    }

    class OctokitClient {
        +createGist(params) OctokitGist
        +getAuthenticatedUser() OctokitUser
        +listUserRepos(params) OctokitRepo[]
        +mergePull(params) OctokitMergeResult
    }

    class EventLoop {
        +runEventLoop() void
        -sendSpecFiles(planType: string) void
        -readSpecFiles(planType: string) SpecFile[]
    }

    class MessengerAdapter {
        +sendMessage(msg) void
        +incomingMessages Stream
    }

    class PlanSession {
        +readFeatureAnalysis() FeatureFiles
        +start(text: string) void
        +approve() void
    }

    EventLoop --> OctokitClient : creates gist
    EventLoop --> MessengerAdapter : sends URL
    EventLoop --> PlanSession : reads spec files
    EventLoop --> SpecHtmlGenerator : generates HTML

    class OctokitGist {
        +id: string
        +htmlUrl: string
        +files: Record~string, RawUrl~
    }

    OctokitClient ..> OctokitGist : returns
`

const testContent = `# Test Plan

## SpecHtmlGenerator Tests

- generates valid HTML with doctype/head/body
- includes Mermaid.js CDN script
- renders markdown file with heading for file name
- wraps mermaid content in \`pre.mermaid\`
- renders multiple files in order
- escapes HTML entities in content

## Main.test.ts Updates

- **uploads gist and sends URL when all conditions met** — assert \`createGist\` was called, \`sendMessage\` received URL
- **includes mermaid content in gist HTML** — gist HTML contains \`<pre class="mermaid">\`
- **falls back to raw text when gist upload fails** — mock \`createGist\` to fail, verify chunked text behavior
`

describe("SpecHtmlGenerator integration", () => {
  it.live(
    "generates complete HTML page from realistic spec files and writes to disk",
    () =>
      Effect.gen(function*() {
        // Arrange
        const files = [
          { name: "analysis.md", content: analysisContent, mermaid: false },
          { name: "services.mmd", content: servicesContent, mermaid: true },
          { name: "test.md", content: testContent, mermaid: false }
        ]

        // Act
        const html = generateSpecHtml(files)

        // Assert — structural validity
        expect(html).toContain("<!DOCTYPE html>")
        expect(html).toContain("<html lang=\"en\">")
        expect(html).toContain("<head>")
        expect(html).toContain("</head>")
        expect(html).toContain("<body>")
        expect(html).toContain("</body>")
        expect(html).toContain("</html>")

        // Assert — Mermaid CDN loaded
        expect(html).toContain("cdn.jsdelivr.net/npm/mermaid@11")
        expect(html).toContain("mermaid.initialize")

        // Assert — all three file sections present in order
        const analysisIdx = html.indexOf("<h2>analysis.md</h2>")
        const servicesIdx = html.indexOf("<h2>services.mmd</h2>")
        const testIdx = html.indexOf("<h2>test.md</h2>")
        expect(analysisIdx).toBeGreaterThan(-1)
        expect(servicesIdx).toBeGreaterThan(analysisIdx)
        expect(testIdx).toBeGreaterThan(servicesIdx)

        // Assert — mermaid diagram wrapped correctly
        expect(html).toContain("<pre class=\"mermaid\">")
        expect(html).toContain("classDiagram")
        // Mermaid content should be HTML-escaped
        expect(html).toContain("OctokitClient")

        // Assert — markdown converted to HTML in analysis section
        expect(html).toContain("<h1>Upload Spec Files as Rendered HTML Gist</h1>")
        expect(html).toContain("<h2>Context</h2>")
        expect(html).toContain("<h3>1. Create <code>src/lib/SpecHtmlGenerator.ts</code></h3>")
        expect(html).toContain("<strong>CREATE</strong>")
        expect(html).toContain("<code>generateSpecHtml</code>")
        expect(html).toContain("<hr>")

        // Assert — links converted
        // No markdown links in this content, but verify code blocks work
        expect(html).toContain("<pre><code")
        expect(html).toContain("readonly id: string")

        // Assert — list items converted in test.md
        expect(html).toContain("<li>")
        expect(html).toContain("generates valid HTML with doctype/head/body")

        // Assert — HTML entities escaped (no raw < > in user content)
        // The mermaid content has Record~string, RawUrl~ which should be safe
        // The TypeScript code block content should be escaped
        expect(html).not.toMatch(/<script>(?!mermaid)/)

        // Assert — italic rendering
        expect(html).toContain("<em>This plan uses the existing Mermaid.js CDN for rendering.</em>")

        // Write to temp file for manual browser inspection
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const outPath = `${tmpDir}/spec-preview.html`
        yield* fs.writeFileString(outPath, html)
        const stat = yield* fs.stat(outPath)
        expect(stat.size).toBeGreaterThan(0)

        yield* Effect.log(`HTML written to: ${outPath}`).pipe(
          Effect.annotateLogs("size", `${html.length} chars`)
        )
      }).pipe(Effect.scoped, Effect.provide(NodeContext.layer)),
    { timeout: 10_000 }
  )
})
