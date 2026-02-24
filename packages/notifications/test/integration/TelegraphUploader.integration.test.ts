import { FetchHttpClient } from "@effect/platform"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { SpecFile } from "../../src/lib/SpecHtmlGenerator.js"
import { specFilesToTelegraphNodes } from "../../src/lib/TelegraphMarkdown.js"
import { PlanOverviewUploader, TelegraphPlanOverviewUploaderLive } from "../../src/services/PlanOverviewUploader.js"

const TestUploader = TelegraphPlanOverviewUploaderLive.pipe(Layer.provide(FetchHttpClient.layer))

const analysisContent = `# Feature Analysis

## Overview

This feature adds real-time notifications for pull request status changes.

## Changes

| File | Action |
|------|--------|
| \`src/services/PRWatcher.ts\` | **CREATE** — watches for PR events |
| \`src/services/EventLoop.ts\` | **MODIFY** — integrate PRWatcher stream |

### 1. Create PRWatcher service

\`\`\`typescript
interface PRWatcher {
  readonly events: Stream<PREvent>
}
\`\`\`

The service polls GitHub API every 30 seconds and emits events on state changes.

---

*No breaking changes expected.*
`

const servicesContent = `classDiagram
    class PRWatcher {
        +events Stream~PREvent~
    }

    class EventLoop {
        +runEventLoop() void
    }

    class GitHubClient {
        +listPulls() PullRequest[]
    }

    EventLoop --> PRWatcher : subscribes
    PRWatcher --> GitHubClient : polls
`

const testContent = `# Test Plan

## PRWatcher Tests

- emits event when PR state changes from open to merged
- debounces rapid state changes within 5 second window
- handles GitHub API rate limit gracefully
`

const testFiles: ReadonlyArray<SpecFile> = [
  { name: "analysis.md", content: analysisContent, mermaid: false },
  { name: "services.mmd", content: servicesContent, mermaid: true },
  { name: "test.md", content: testContent, mermaid: false }
]

describe("Telegraph uploader integration", () => {
  it.live(
    "uploads spec with mermaid diagrams and returns valid telegra.ph URL",
    () =>
      Effect.gen(function*() {
        // Arrange
        const uploader = yield* PlanOverviewUploader

        // Act
        const result = yield* uploader.upload({ files: testFiles, description: "Integration test — safe to delete" })

        // Assert
        expect(result.url).toMatch(/^https:\/\/telegra\.ph\//)

        const response = yield* Effect.tryPromise({
          try: () => fetch(result.url),
          catch: (err) => new Error(`Failed to fetch uploaded page: ${err}`)
        })
        expect(response.status).toBe(200)

        const body = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (err) => new Error(`Failed to read response body: ${err}`)
        })
        expect(body).toContain("Feature Analysis")
        expect(body).toContain("PRWatcher")
      }).pipe(Effect.provide(TestUploader)),
    { timeout: 30_000 }
  )

  it.live(
    "specFilesToTelegraphNodes produces valid Node array for Telegraph API",
    () =>
      Effect.sync(() => {
        // Arrange
        const files: ReadonlyArray<SpecFile> = [
          { name: "analysis.md", content: analysisContent, mermaid: false },
          { name: "services.mmd", content: servicesContent, mermaid: true }
        ]

        // Act
        const content = specFilesToTelegraphNodes(files)

        // Assert — returns Node array
        expect(Array.isArray(content)).toBe(true)
        const str = JSON.stringify(content)

        // Assert — mermaid replaced with kroki img
        expect(str).toContain("kroki.io/plantuml/svg/")
        expect(str).toContain("\"tag\":\"img\"")

        // Assert — content preserved
        expect(str).toContain("Feature Analysis")
        expect(str).toContain("PRWatcher")
      }),
    { timeout: 10_000 }
  )
})
