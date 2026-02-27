import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { parseNdjsonMessages } from "../src/lib/StreamJsonParser.js"

const parseMessages = (lines: ReadonlyArray<string>) =>
  Stream.fromIterable(lines).pipe(
    Stream.map((line) => line + "\n"),
    parseNdjsonMessages,
    Stream.runCollect,
    Effect.map((chunk) => [...chunk])
  )

describe("StreamJsonParser", () => {
  describe("parseNdjsonMessages", () => {
    it.effect("parses assistant text message", () =>
      Effect.gen(function*() {
        // Arrange
        const ndjson = [JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello from Claude" }]
          }
        })]

        // Act
        const result = yield* parseMessages(ndjson)

        // Assert
        expect(result).toHaveLength(1)
        expect(result[0]!.type).toBe("assistant")
        expect(result[0]!.message?.content?.[0]?.text).toBe("Hello from Claude")
      }))

    it.effect("parses tool_use AskUserQuestion block", () =>
      Effect.gen(function*() {
        // Arrange
        const ndjson = [JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              name: "AskUserQuestion",
              input: {
                questions: [{
                  question: "Which approach?",
                  header: "Approach",
                  options: [
                    { label: "Option A", description: "First option" },
                    { label: "Option B", description: "Second option" }
                  ],
                  multiSelect: false
                }]
              }
            }]
          }
        })]

        // Act
        const result = yield* parseMessages(ndjson)

        // Assert
        expect(result).toHaveLength(1)
        const block = result[0]!.message!.content![0]!
        expect(block.type).toBe("tool_use")
        expect(block.name).toBe("AskUserQuestion")
      }))

    it.effect("parses system and result messages", () =>
      Effect.gen(function*() {
        // Arrange
        const ndjson = [
          JSON.stringify({ type: "system", subtype: "init" }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
          JSON.stringify({ type: "result", subtype: "success" })
        ]

        // Act
        const result = yield* parseMessages(ndjson)

        // Assert
        expect(result).toHaveLength(3)
        expect(result[0]!.type).toBe("system")
        expect(result[1]!.type).toBe("assistant")
        expect(result[2]!.type).toBe("result")
      }))

    it.effect("handles malformed lines by filtering them out", () =>
      Effect.gen(function*() {
        // Arrange
        const ndjson = [
          "not valid json",
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "valid" }] } }),
          "also { broken",
          ""
        ]

        // Act
        const result = yield* parseMessages(ndjson)

        // Assert
        expect(result).toHaveLength(1)
        expect(result[0]!.type).toBe("assistant")
      }))

    it.effect("silently filters non-JSON lines", () =>
      Effect.gen(function*() {
        // Arrange
        const ndjson = [
          "not valid json",
          JSON.stringify({ type: "system", subtype: "init" })
        ]

        // Act
        const result = yield* parseMessages(ndjson)

        // Assert
        expect(result).toHaveLength(1)
        expect(result[0]!.type).toBe("system")
      }))
  })
})
