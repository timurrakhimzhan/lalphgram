# claude-shim — SDK-based Claude Binary Replacement

## What It Does

Replaces the real `claude` CLI with an SDK-based wrapper that:
1. Streams all Claude responses as NDJSON to stdout (for `PlanSession` to parse)
2. Accepts control messages on stdin (follow-ups, interrupts, approvals, aborts)
3. Provides a custom MCP `ask_user` tool so Claude can ask questions routed through Telegram

## Source Files

| File | Purpose |
|---|---|
| `src/bin.ts` | Executable entry point — wires `shimProgram` with real process I/O |
| `src/main.ts` | Core logic — `shimProgram` Effect, MCP server, stdin routing |
| `src/parseArgs.ts` | CLI argument parsing (`--model`, `--dangerously-skip-permissions`, prompt) |
| `src/schemas.ts` | Effect Schema definitions for stdin control messages |

## Exports

### `ShimDeps` (Context.Tag)
Injectable dependencies for testing:
```ts
interface ShimDepsService {
  args: ReadonlyArray<string>        // CLI args (minus program name)
  createQuery: typeof query           // SDK query factory
  stdout: { write(data: string): boolean }
  stderr: { write(data: string): boolean }
  stdin: NodeJS.ReadableStream
  env: Record<string, string | undefined>
}
```

### `ShimError` (Data.TaggedError)
`{ message: string, cause: unknown }`

### `shimProgram` (Effect)
The main program. Requires `ShimDeps` in context. Scoped (uses finalizers).

### `parseArgs(args): ParsedArgs`
Returns `{ prompt: string, dangerouslySkipPermissions: boolean, model: string | null }`.

### `decodeShimMessage(line): Either<ParseError, ShimMessage>`
Parses a JSON line into a typed control message.

### `collectAnswers(questionCount, answerQueue, closedRef, stderr)`
Blocks on queue until N answers collected. Returns MCP tool response.

### `createAskUserMcpServer(answerQueue, closedRef, stderr)`
Creates MCP server with one tool: `ask_user`.

---

## Program Flow (`shimProgram`)

### 1. Initialization
- Parse CLI args via `parseArgs`
- Read `REAL_CLAUDE_PATH` env var (required — path to actual claude binary)
- Resolve model: `--model` flag > `CLAUDE_MODEL` env > `"claude-sonnet-4-6"`
- Create state: `answerQueue`, `closedRef`, `routingActive`, `queryHandleRef`, `sessionIdRef`, `followUpQueue`

### 2. Stdin Reader (forked daemon)
Reads stdin lines and routes based on `routingActive` state:

**Before handshake** (`routingActive = false`): all lines go to `answerQueue` (for handshake + ask_user answers).

**After handshake** (`routingActive = true`): each line is decoded via `decodeShimMessage`:
- Decode fails → goes to `answerQueue` (plain text answer for ask_user)
- Decode succeeds → routed by message type (see Message Types below)

### 3. Handshake Protocol
```
shim → stdout:  { "type": "shim_ready" }
stdin → shim:   { "type": "shim_start" }   ← proceed
                 OR
                { "type": "shim_abort" }    ← exit immediately
```

### 4. Query Execution
- Initial prompt offered to `followUpQueue`
- SDK `Query` created with:
  - `prompt`: async iterable from `followUpQueue` (terminates on `FollowUpStop` symbol)
  - `mcpServers`: `{ "ask-user": mcpServer }`
  - `disallowedTools`: `["AskUserQuestion"]` (force use of MCP version)
  - `permissionMode`: `"bypassPermissions"` if `--dangerously-skip-permissions`
- Query handle stored in `queryHandleRef` (for interrupt)
- `routingActive` set to `true`
- All `SDKMessage` objects streamed to stdout as JSON lines
- Session ID captured from first `system/init` message

### 5. Finalizers (on scope close)
- `q.close()` — close SDK query
- Offer `FollowUpStop` to followUpQueue — terminate follow-up iterable

---

## Stdin Control Messages (schemas.ts)

All messages are JSON objects with a `type` field.

| Type | Fields | What It Does |
|---|---|---|
| `shim_start` | `text?` | Handshake response — start query execution |
| `shim_abort` | — | Abort — close followUpQueue, terminate |
| `shim_interrupt` | `text?` | Call `q.interrupt()`, then offer text as new user message |
| `shim_approve` | `text?` | Offer approval text (or default) as user message, then close followUpQueue |
| `follow_up` | `text` (required) | Offer text as additional user message to ongoing query |

### Message Routing Detail

**`follow_up`**: Wraps text as `SDKUserMessage` and offers to `followUpQueue`. Query picks it up as next user turn.

**`shim_approve`**: Wraps text (default: "The user has approved. Proceed with implementation.") as user message, then sends `FollowUpStop`. Query processes approval then terminates.

**`shim_interrupt`**: Calls `q.interrupt()` to stop current streaming. If text provided, offers as new user message. Query resumes with new input.

**`shim_abort`**: Sends `FollowUpStop` immediately. Query terminates without processing further.

---

## MCP ask_user Tool

**Tool name**: `ask_user`

**Schema**:
```ts
{
  questions: [{
    question: string         // The question text
    header?: string          // Short label (max 12 chars)
    options: [{              // 2-4 choices
      label: string          // Display text (1-5 words)
      description?: string   // Explanation
    }]
    multiSelect?: boolean
  }]
}
```

**Flow**:
1. Claude calls `ask_user` tool via MCP
2. Tool handler calls `collectAnswers(N, answerQueue, closedRef, stderr)`
3. `collectAnswers` blocks on `answerQueue.take()` until N non-empty lines received
4. PlanSession (in notifications package) sends answers via stdin as plain text
5. Returns `"User answered: opt1; opt2"` to Claude

---

## CLI Arguments (`parseArgs`)

| Arg | Effect |
|---|---|
| `--model <value>` | Override model selection |
| `--dangerously-skip-permissions` | Set `permissionMode: "bypassPermissions"` |
| `--output-format <value>` | Skipped (SDK handles internally) |
| `-p`, `--print`, `--verbose` | Ignored |
| `--` | Everything after is joined as prompt |
| First positional arg | Used as prompt |

---

## How PlanSession Uses the Shim

1. PlanSession spawns `claude-shim` as subprocess with PATH shimming
2. Reads stdout for `shim_ready`, responds with `shim_start` on stdin
3. Parses NDJSON stdout: `assistant` messages (text/tool_use), `result` messages
4. Routes `ask_user` tool calls as `PlanQuestion` events to Telegram
5. Sends answers back via plain text on stdin
6. Sends control messages (`follow_up`, `shim_interrupt`, `shim_approve`, `shim_abort`) on stdin
7. On scope close, process is terminated

---

## Spec File Detection (Cross-Package)

The shim has **no awareness** of spec files — it streams all SDK messages (including `tool_use` blocks with `file_path`) as-is to stdout. The spec file conventions are established upstream and consumed downstream:

1. **Origin of `.specs/` and `plan.json` conventions** — The external `lalph` tool's system prompt (`repos/lalph/src/PromptGen.ts` → `planPrompt`) instructs Claude to write specs to `.specs/` and `plan.json`
2. **Origin of `.specs/analysis.md` convention** — `notifications/src/lib/AnalysisPrompts.ts` (`getAnalysisPrompt`) generates follow-up prompts that tell Claude to write analysis to `.specs/analysis.md`. These are sent as `follow_up` stdin messages through the shim
3. **Detection** — `notifications/src/services/PlanSession.ts` parses the NDJSON stream from the shim, extracts `file_path` from `Write`/`Edit`/`NotebookEdit` `tool_use` blocks, and classifies paths via `isSpecFile` / `isAnalysisFile` to emit typed events (`PlanSpecCreated`, `PlanSpecUpdated`, `PlanAnalysisReady`)

The shim's role is purely transport — it neither inspects nor transforms file paths.
