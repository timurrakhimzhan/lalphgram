import { Command } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { AppContext } from "../src/services/AppContext.js"
import {
  PlanCommandBuilder,
  PlanCompleted,
  PlanFailed,
  PlanQuestion,
  PlanSession,
  PlanSessionLive,
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
})
