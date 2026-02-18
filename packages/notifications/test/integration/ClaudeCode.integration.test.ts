import { Command, CommandExecutor } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { Duration } from "effect"
import { Chunk, Effect, Exit, Queue, Schema, Scope, Stream } from "effect"
import {
  AskUserQuestionInput,
  parseNdjsonMessages,
  StreamJsonInput,
  type StreamJsonMessage
} from "../../src/lib/StreamJsonParser.js"

const spawnClaude = () =>
  Command.make("claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose").pipe(
    Command.stdout("pipe"),
    Command.stderr("pipe"),
    Command.stdin("pipe")
  )

const drainStderr = (stderr: Stream.Stream<Uint8Array, unknown>) => {
  const decoder = new TextDecoder()
  return stderr.pipe(
    Stream.map((chunk) => decoder.decode(chunk)),
    Stream.mapEffect((text) => Effect.sync(() => globalThis.process.stderr.write(text))),
    Stream.runDrain,
    Effect.forkDaemon
  )
}

const collectMessages = (stdout: Stream.Stream<Uint8Array, unknown>) => {
  const decoder = new TextDecoder()
  return Effect.gen(function*() {
    const queue = yield* Queue.unbounded<StreamJsonMessage>()

    yield* stdout.pipe(
      Stream.map((chunk) => decoder.decode(chunk)),
      // eslint-disable-next-line @template/no-catch-all-recovery -- error type is unknown from process stdout, catchTag not possible
      Stream.catchAll((err) =>
        Stream.fromEffect(Effect.logError(`stdout stream error: ${String(err)}`)).pipe(Stream.drain)
      ),
      parseNdjsonMessages,
      Stream.mapEffect((msg) => Queue.offer(queue, msg)),
      Stream.runDrain,
      Effect.catchAll((err) => Effect.logError(`collect messages error: ${String(err)}`)),
      Effect.forkDaemon
    )

    return queue
  })
}

const waitForEvent = (
  queue: Queue.Queue<StreamJsonMessage>,
  predicate: (msg: StreamJsonMessage) => boolean,
  timeout: Duration.DurationInput = "120 seconds"
) =>
  Stream.fromQueue(queue).pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map(Chunk.unsafeHead),
    Effect.timeout(timeout)
  )

const encodeInput = Schema.encodeSync(StreamJsonInput)
const encoder = new TextEncoder()

const pipeStdin = (process: CommandExecutor.Process) =>
  Effect.gen(function*() {
    const outbox = yield* Queue.unbounded<Uint8Array>()

    yield* Stream.fromQueue(outbox).pipe(
      Stream.run(process.stdin),
      Effect.catchAll((err) => Effect.logError(`stdin pipe error: ${String(err)}`)),
      Effect.forkDaemon
    )

    return outbox
  })

const sendMessage = (outbox: Queue.Queue<Uint8Array>, text: string, parentToolUseId: string | null = null) => {
  const msg = encodeInput(
    new StreamJsonInput({
      type: "user",
      message: { role: "user", content: text },
      session_id: "default",
      parent_tool_use_id: parentToolUseId
    })
  )
  return Queue.offer(outbox, encoder.encode(JSON.stringify(msg) + "\n"))
}

const isAssistantText = (msg: StreamJsonMessage): boolean =>
  msg.type === "assistant" &&
  msg.message?.content != null &&
  msg.message.content.some((b) => b.type === "text" && b.text != null)

const isAskUserQuestion = (msg: StreamJsonMessage): boolean =>
  msg.type === "assistant" &&
  msg.message?.content != null &&
  msg.message.content.some((b) => b.type === "tool_use" && b.name === "AskUserQuestion")

const getTextContent = (msg: StreamJsonMessage): string => {
  const texts = msg.message?.content
    ?.filter((b) => b.type === "text" && b.text != null)
    .map((b) => b.text ?? "")
  return texts?.join("") ?? ""
}

const decodeAskInput = Schema.decodeUnknownSync(AskUserQuestionInput)

const getAskUserQuestionInput = (msg: StreamJsonMessage) => {
  const block = msg.message?.content?.find(
    (b) => b.type === "tool_use" && b.name === "AskUserQuestion"
  )
  if (block?.input == null) return undefined
  return decodeAskInput(block.input)
}

const getToolUseId = (msg: StreamJsonMessage, toolName: string): string | undefined =>
  msg.message?.content?.find((b) => b.type === "tool_use" && b.name === toolName)?.id

describe("ClaudeCode integration", () => {
  it.live(
    "multi-turn text conversation without tool use",
    () =>
      Effect.gen(function*() {
        // Arrange
        const executor = yield* CommandExecutor.CommandExecutor
        const scope = yield* Scope.make()
        const process = yield* Command.start(spawnClaude()).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Scope.extend(scope)
        )
        yield* drainStderr(process.stderr)
        const outbox = yield* pipeStdin(process)
        const queue = yield* collectMessages(process.stdout)

        // Act — first turn
        yield* sendMessage(outbox, "My name is Timur. Remember it. Do not use any tools. Just respond with text.")
        const first = yield* waitForEvent(queue, isAssistantText)
        expect(getTextContent(first).toLowerCase()).toContain("timur")

        // Act — second turn: ask Claude to recall
        yield* sendMessage(outbox, "What is my name? Do not use any tools.")
        const second = yield* waitForEvent(queue, isAssistantText)
        expect(getTextContent(second).toLowerCase()).toContain("timur")

        // Cleanup
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.provide(NodeContext.layer)),
    { timeout: 120_000 }
  )

  it.live(
    "multiple choice: Claude presents options and we select one",
    () =>
      Effect.gen(function*() {
        // Arrange
        const executor = yield* CommandExecutor.CommandExecutor
        const scope = yield* Scope.make()
        const process = yield* Command.start(spawnClaude()).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Scope.extend(scope)
        )
        yield* drainStderr(process.stderr)
        const outbox = yield* pipeStdin(process)
        const queue = yield* collectMessages(process.stdout)

        // Act — ask Claude to present multiple choice options
        yield* sendMessage(
          outbox,
          "Use the AskUserQuestion tool to ask: \"Which programming language do you prefer?\" with these exact options: label \"TypeScript\" description \"Statically typed JS\", label \"Python\" description \"Dynamic and versatile\", label \"Rust\" description \"Systems programming\". Do not do anything else."
        )

        // Wait for the AskUserQuestion with options
        const askEvent = yield* waitForEvent(queue, isAskUserQuestion)
        const toolUseId = getToolUseId(askEvent, "AskUserQuestion")
        const input = getAskUserQuestionInput(askEvent)
        expect(input).toBeDefined()
        expect(input!.questions).toBeDefined()
        expect(input!.questions!.length).toBeGreaterThan(0)
        const question = input!.questions![0]!
        expect(question.options).toBeDefined()
        expect(question.options!.length).toBeGreaterThanOrEqual(2)

        // Select "TypeScript"
        yield* sendMessage(outbox, "TypeScript", toolUseId ?? null)

        // Assert — Claude should respond referencing our selection
        const response = yield* waitForEvent(queue, isAssistantText)
        const text = getTextContent(response)
        expect(text.toLowerCase()).toContain("typescript")

        // Cleanup
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.provide(NodeContext.layer)),
    { timeout: 120_000 }
  )
})
