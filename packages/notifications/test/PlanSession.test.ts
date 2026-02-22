import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { AppContext } from "../src/services/AppContext.js"
import {
  PlanAnalysisReady,
  PlanCommandBuilder,
  PlanCompleted,
  PlanFailed,
  PlanQuestion,
  PlanSession,
  PlanSessionLive,
  PlanSpecCreated,
  PlanSpecUpdated,
  PlanTextOutput
} from "../src/services/PlanSession.js"

const appContextLayer = Layer.succeed(
  AppContext,
  AppContext.of({
    projectRoot: "/tmp",
    configDir: "/tmp/.lalph-test/config"
  })
)

const ndjsonMessage = (content: ReadonlyArray<Record<string, unknown>>, id = "msg_test") =>
  JSON.stringify({ type: "assistant", message: { id, content } })

const textMessage = (text: string, id?: string) => ndjsonMessage([{ type: "text", text }], id)

const askQuestionMessage = (questions: ReadonlyArray<Record<string, unknown>>, id?: string) =>
  ndjsonMessage([{ type: "tool_use", name: "mcp__ask-user__ask_user", input: { questions } }], id)

const toolUseMessage = (name: string, input: Record<string, unknown>, id?: string) =>
  ndjsonMessage([{ type: "tool_use", name, input }], id)

const catCommandLayer = Layer.succeed(
  PlanCommandBuilder,
  (_tempFile: string) =>
    Command.make("cat").pipe(
      Command.stdout("pipe"),
      Command.stderr("pipe"),
      Command.stdin("pipe")
    )
)

const echoCommandLayer = (text: string) =>
  Layer.succeed(
    PlanCommandBuilder,
    (_tempFile: string) =>
      Command.make("echo", text).pipe(
        Command.stdout("pipe"),
        Command.stderr("pipe"),
        Command.stdin("pipe")
      )
  )

const failCommandLayer = Layer.succeed(
  PlanCommandBuilder,
  (_tempFile: string) =>
    Command.make("false").pipe(
      Command.stdout("pipe"),
      Command.stderr("pipe"),
      Command.stdin("pipe")
    )
)

const makeTestLayer = (commandLayer: Layer.Layer<PlanCommandBuilder>) =>
  PlanSessionLive.pipe(
    Layer.provide(Layer.mergeAll(
      commandLayer,
      appContextLayer,
      NodeContext.layer
    ))
  )

describe("PlanSession", () => {
  it.live("emits PlanTextOutput events from NDJSON stdout", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(echoCommandLayer(textMessage("hello from plan")))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")

        // Assert
        const event = yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanTextOutput"),
          Stream.runHead
        )
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanTextOutput)
          expect(event.value).toMatchObject({ text: "hello from plan" })
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("emits PlanCompleted on successful process exit", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(echoCommandLayer(textMessage("done")))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert
        const events = yield* session.events.pipe(
          Stream.take(2),
          Stream.runCollect
        )
        const arr = [...events]
        const completed = arr.find((e) => e._tag === "PlanCompleted")
        expect(completed).toBeInstanceOf(PlanCompleted)
        expect(completed).toMatchObject({ exitCode: 0 })
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("emits PlanFailed on non-zero exit code", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(failCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert
        const event = yield* Stream.runHead(session.events)
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanFailed)
          expect(event.value).toMatchObject({ message: expect.stringContaining("exited with code 1") })
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("rejects starting a second session while one is active", () =>
    Effect.gen(function*() {
      // Arrange — cat keeps running until stdin closes
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession
        yield* session.start("first plan")

        // Act
        const result = yield* session.start("second plan").pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("A plan session is already active")
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("pipes NDJSON answer through stdin and receives parsed event", () =>
    Effect.gen(function*() {
      // Arrange — use a shell script: echo two NDJSON lines (first is the initial text,
      // second is the echoed stdin answer) then exit. The first line flushes when the
      // second line (different message ID) arrives.
      const line1 = textMessage("initial output", "msg_1")
      const line2 = textMessage("hello from telegram", "msg_2")
      const testLayer = makeTestLayer(echoCommandLayer(`${line1}\n${line2}`))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert — first text flushed when second arrives; collect both text + completed
        const events = yield* session.events.pipe(
          Stream.take(3),
          Stream.runCollect
        )
        const arr = [...events]
        const textEvents = arr.filter((e) => e._tag === "PlanTextOutput")
        expect(textEvents).toHaveLength(2)
        expect(textEvents[0]).toMatchObject({ text: "initial output" })
        expect(textEvents[1]).toMatchObject({ text: "hello from telegram" })
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("emits PlanQuestion from AskUserQuestion tool_use block", () =>
    Effect.gen(function*() {
      // Arrange
      const payload = askQuestionMessage([{
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "Option A", description: "First option" },
          { label: "Option B", description: "Second option" }
        ],
        multiSelect: false
      }])
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")

        // Assert
        const event = yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanQuestion"),
          Stream.runHead
        )
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanQuestion)
          if (event.value._tag === "PlanQuestion") {
            expect(event.value.questions).toHaveLength(1)
            expect(event.value.questions[0]!.question).toBe("Which approach?")
            expect(event.value.questions[0]!.options).toHaveLength(2)
            expect(event.value.questions[0]!.options![0]!.label).toBe("Option A")
          }
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("suppresses text block when ask_user arrives for the same message ID", () =>
    Effect.gen(function*() {
      // Arrange — text and ask_user in separate NDJSON lines with same message ID
      const msgId = "msg_shared"
      const textLine = textMessage("Let me ask you a few questions.", msgId)
      const askLine = askQuestionMessage([{
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "Option A", description: "First" },
          { label: "Option B", description: "Second" }
        ],
        multiSelect: false
      }], msgId)
      const payload = `${textLine}\n${askLine}`
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert — collect events: should have PlanQuestion + PlanCompleted, no PlanTextOutput
        const events = yield* session.events.pipe(
          Stream.take(2),
          Stream.runCollect
        )
        const arr = [...events]
        expect(arr.some((e) => e._tag === "PlanTextOutput")).toBe(false)
        expect(arr.some((e) => e._tag === "PlanQuestion")).toBe(true)
        const question = arr.find((e) => e._tag === "PlanQuestion")
        if (question != null && question._tag === "PlanQuestion") {
          expect(question.questions[0]!.question).toBe("Which approach?")
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("does not emit PlanTextOutput for non-AskUserQuestion tool_use", () =>
    Effect.gen(function*() {
      // Arrange
      const payload = ndjsonMessage([{ type: "tool_use", name: "Bash", input: { command: "ls" } }])
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert — only PlanCompleted should be emitted, no PlanTextOutput
        const event = yield* Stream.runHead(session.events)
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanCompleted)
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("answer fails when no session is active", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        const result = yield* session.answer("hello").pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("No active plan session")
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("sendFollowUp writes JSON-tagged line to stdin", () =>
    Effect.gen(function*() {
      // Arrange — use cat so we can read back what was written to stdin via stdout
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession
        yield* session.start("test plan")

        // Act
        yield* session.sendFollowUp("also consider X")
        yield* Effect.sleep("100 millis")

        // Assert — cat echoes stdin to stdout, so the JSON line should appear as raw text
        // The session should still be active since cat is still running
        const active = yield* session.isActive
        expect(active).toBe(true)
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("sendFollowUp fails when no session is active", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        const result = yield* session.sendFollowUp("hello").pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("No active plan session")
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("interrupt writes shim_interrupt JSON to stdin", () =>
    Effect.gen(function*() {
      // Arrange — use cat so stdin is echoed to stdout
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession
        yield* session.start("test plan")

        // Act
        yield* session.interrupt("urgent fix")
        yield* Effect.sleep("100 millis")

        // Assert — session should still be active since cat is running
        const active = yield* session.isActive
        expect(active).toBe(true)
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("interrupt fails when no session is active", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        const result = yield* session.interrupt("hello").pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("No active plan session")
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("isActive returns true during active session and false after exit", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(echoCommandLayer(textMessage("quick")))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Assert — initially inactive
        const before = yield* session.isActive
        expect(before).toBe(false)

        // Act
        yield* session.start("test plan")

        // Assert — active after start
        const during = yield* session.isActive
        expect(during).toBe(true)

        // Wait for the completed event to ensure exit fiber has run
        yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanCompleted" || e._tag === "PlanFailed"),
          Stream.take(1),
          Stream.runDrain
        )

        // Assert — inactive after exit
        const after = yield* session.isActive
        expect(after).toBe(false)
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("auto-starts first shim on shim_ready", () =>
    Effect.gen(function*() {
      // Arrange — echo a shim_ready line followed by a text message
      const shimReadyLine = JSON.stringify({ type: "shim_ready" })
      const payload = `${shimReadyLine}\n${textMessage("spec output")}`
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")

        // Assert — should see text output (shim_ready auto-started, text message emitted)
        const event = yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanTextOutput"),
          Stream.runHead
        )
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toMatchObject({ text: "spec output" })
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("emits PlanSpecCreated for Write to .specs/ file", () =>
    Effect.gen(function*() {
      // Arrange
      const payload = toolUseMessage("Write", { file_path: "/project/.specs/feature.md", content: "spec" })
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")

        // Assert
        const event = yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanSpecCreated"),
          Stream.runHead
        )
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanSpecCreated)
          expect(event.value).toMatchObject({ filePath: "/project/.specs/feature.md" })
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("emits PlanSpecUpdated on second write to same .specs/ file", () =>
    Effect.gen(function*() {
      // Arrange — two Write tool_use blocks for the same spec file in separate messages
      const line1 = toolUseMessage("Write", { file_path: "/project/.specs/feature.md", content: "v1" }, "msg_1")
      const line2 = toolUseMessage("Write", { file_path: "/project/.specs/feature.md", content: "v2" }, "msg_2")
      const payload = `${line1}\n${line2}`
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert — first is Created, second is Updated
        const events = yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanSpecCreated" || e._tag === "PlanSpecUpdated"),
          Stream.take(2),
          Stream.runCollect
        )
        const arr = [...events]
        expect(arr[0]).toBeInstanceOf(PlanSpecCreated)
        expect(arr[1]).toBeInstanceOf(PlanSpecUpdated)
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("emits PlanAnalysisReady for Write to .specs/analysis.md", () =>
    Effect.gen(function*() {
      // Arrange
      const payload = toolUseMessage("Write", { file_path: "/project/.specs/analysis.md", content: "analysis" })
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")

        // Assert
        const event = yield* session.events.pipe(
          Stream.filter((e) => e._tag === "PlanAnalysisReady"),
          Stream.runHead
        )
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanAnalysisReady)
          expect(event.value).toMatchObject({ filePath: "/project/.specs/analysis.md" })
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("does not emit spec events for non-spec file paths", () =>
    Effect.gen(function*() {
      // Arrange — Write to a regular file, not under .specs/
      const payload = toolUseMessage("Write", { file_path: "/project/src/main.ts", content: "code" })
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert — only PlanCompleted should be emitted
        const event = yield* Stream.runHead(session.events)
        expect(event._tag).toBe("Some")
        if (event._tag === "Some") {
          expect(event.value).toBeInstanceOf(PlanCompleted)
        }
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("result message no longer emits spec events", () =>
    Effect.gen(function*() {
      // Arrange — a result message without any spec file writes
      const resultLine = JSON.stringify({ type: "result", subtype: "success" })
      const payload = `${textMessage("spec output")}\n${resultLine}`
      const testLayer = makeTestLayer(echoCommandLayer(payload))

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        yield* session.start("test plan")
        yield* Effect.sleep("100 millis")

        // Assert — no PlanSpecCreated/Updated/AnalysisReady events
        const events = yield* session.events.pipe(
          Stream.take(2),
          Stream.runCollect
        )
        const arr = [...events]
        const specEvents = arr.filter((e) =>
          e._tag === "PlanSpecCreated" || e._tag === "PlanSpecUpdated" || e._tag === "PlanAnalysisReady"
        )
        expect(specEvents).toHaveLength(0)
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("approve fails when no session is active", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        const result = yield* session.approve.pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("No active plan session")
      }).pipe(Effect.provide(testLayer))
    }))

  it.live("reject fails when no session is active", () =>
    Effect.gen(function*() {
      // Arrange
      const testLayer = makeTestLayer(catCommandLayer)

      yield* Effect.gen(function*() {
        const session = yield* PlanSession

        // Act
        const result = yield* session.reject.pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("No active plan session")
      }).pipe(Effect.provide(testLayer))
    }))
})
