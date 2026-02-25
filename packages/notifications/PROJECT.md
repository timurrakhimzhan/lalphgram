# notifications — Main Application

## What It Does

Event-driven notification hub that:
- Polls GitHub and Linear for PR/task changes
- Sends Telegram notifications for conflicts, CI failures, new PRs, task updates
- Auto-merges PRs when CI passes after a configurable wait
- Manages interactive Claude plan sessions via Telegram (collect plan, ask questions, approve/reject)

## Entry Point: `Main.ts`

CLI via `@effect/cli` with options:
- `--interval` — Poll interval seconds (default: 30)
- `--keyword` — Comment timer trigger keyword (default: "urgent")
- `--timer` — Comment timer delay seconds (default: 300)

**Startup flow**:
1. Initialize `TelegramConfig` — prompt for bot token if missing
2. Prompt for auto-merge settings (enabled, max wait minutes)
3. Build `PlanCommandBuilder` — spawns `lalph plan` with PATH shimming to use `src/shim/bin.ts`
4. Build `MainLayer` with all services
5. Wait for first Telegram message (to confirm chat ID)
6. Run `EventLoop`

---

## Services

### AppContext
**File**: `services/AppContext.ts` | **Tag**: `AppContext`

Resolves project root by walking up to find `.lalph/` directory. Provides `projectRoot` and `configDir` (`~/.lalph/config`).

| Method | Signature | Description |
|---|---|---|
| `projectRoot` | `string` | Root dir containing `.lalph/` |
| `configDir` | `string` | `~/.lalph/config/` |

**Error**: `AppContextError`
**Layer**: `AppContextLive` — uses `FileSystem` to walk directories

---

### AppRuntimeConfig
**File**: `services/AppRuntimeConfig.ts` | **Tag**: `AppRuntimeConfig`

Schema.Class holding CLI-provided runtime settings. No Live layer — provided manually in Main.ts.

| Field | Type | Default |
|---|---|---|
| `pollIntervalSeconds` | number | 30 |
| `triggerKeyword` | string | "urgent" |
| `timerDelaySeconds` | number | 300 |
| `autoMergeEnabled` | boolean | false |
| `autoMergeWaitMinutes` | number | 10 |

---

### TelegramConfig
**File**: `services/TelegramConfig.ts` | **Tag**: `TelegramConfig`

Reads/writes Telegram bot config from `~/.lalph/config/notify.telegram`.

| Method | Signature |
|---|---|
| `get` | `Effect<Option<{ botToken, chatId }>>` |
| `set` | `(config) => Effect<void>` |

**Error**: `TelegramConfigError`
**Layer**: `TelegramConfigLive` — requires `AppContext`

---

### LalphConfig
**File**: `services/LalphConfig.ts` | **Tag**: `LalphConfig`

Reads credentials from `~/.lalph/config/` files. Watches file system for token changes and auto-refreshes.

| Method/Property | Type | Description |
|---|---|---|
| `githubToken` | `Effect<string>` | Dynamic — re-reads on file change |
| `linearToken` | `Effect<string>` | Dynamic — re-reads on file change |
| `issueSource` | `"linear" \| "github"` | Static — from `settings.issueSource` file |
| `specUploader` | `"gist" \| "telegraph"` | Static — from `settings.specUploader` (default `"telegraph"`) |
| `repoFullName` | `string` | Parsed from `git remote get-url origin` |

**Error**: `LalphConfigError`
**Layer**: `LalphConfigLive` (scoped) — requires `AppContext`, `FileSystem`, `CommandExecutor`

---

### MessengerAdapter (interface) / TelegramAdapter (impl)
**Files**: `services/MessengerAdapter/MessengerAdapter.ts`, `TelegramAdapter.ts` | **Tag**: `MessengerAdapter`

| Method | Signature | Description |
|---|---|---|
| `sendMessage` | `(string \| OutgoingMessage) => Effect<void>` | Send to Telegram. Supports inline/reply keyboards. |
| `incomingMessages` | `Stream<IncomingMessage>` | Queue-backed stream of text messages + button clicks |

**Types**:
- `IncomingMessage`: `{ chatId, text, from }`
- `OutgoingMessage`: `{ text, options?: [{ label }], replyKeyboard?: [[{ text }]] }`

**Error**: `MessengerAdapterError`
**Layer**: `TelegramAdapterLive` — requires `TelegramConfig`. Uses Telegraf. HTML parse mode. Button callbacks stored as `q:qId:optIndex`.

---

### OctokitClient
**File**: `services/OctokitClient.ts` | **Tag**: `OctokitClient`

Low-level Octokit SDK wrapper. Dynamically refreshes if GitHub token changes.

| Method | Description |
|---|---|
| `getAuthenticatedUser()` | Returns `{ login }` |
| `listUserRepos(opts)` | List repos |
| `listPulls(owner, repo, state, perPage)` | List PRs |
| `getPull(owner, repo, pullNumber)` | Get PR detail (includes `mergeable_state`) |
| `createIssueComment(...)` | Post comment on issue/PR |
| `listIssueComments(...)` | List issue comments |
| `listPullReviewComments(...)` | List review comments |
| `getCombinedStatusForRef(...)` | Get commit status |
| `listCheckRunsForRef(...)` | Get check runs |
| `mergePull(...)` | Merge a PR |
| `listUserIssues(...)` | List issues assigned to user |
| `getIssue(...)` | Get single issue |
| `addIssueLabels(...)` | Add labels to issue |
| `createGist(...)` | Create a GitHub Gist (description, files, isPublic) → `OctokitGist` |

**Models**: `OctokitUser`, `OctokitRepo`, `OctokitPullRequest`, `OctokitPullRequestDetail`, `OctokitComment`, `OctokitIssue`, `OctokitIssueDetail`, `OctokitCheckRun`, `OctokitCombinedStatus`, `OctokitMergeResult`, `OctokitGist` (`{ id, htmlUrl, files: Record<string, { rawUrl }> }`)

**Error**: `OctokitClientError`
**Layer**: `OctokitClientLive` — requires `LalphConfig`

---

### GitHubClient
**File**: `services/GitHubClient.ts` | **Tag**: `GitHubClient`

Higher-level wrapper around `OctokitClient` with normalized response types.

| Method | Returns |
|---|---|
| `getAuthenticatedUser()` | `{ login }` |
| `listUserRepos()` | `GitHubRepo[]` |
| `listOpenPRs(repo)` | `GitHubPullRequest[]` |
| `getPR(repo, prNumber)` | `GitHubPullRequest` |
| `postComment(repo, prNumber, body)` | void |
| `listComments(repo, prNumber)` | `GitHubComment[]` |
| `listReviewComments(repo, prNumber)` | `GitHubComment[]` |
| `getCIStatus(repo, ref)` | `{ state, checkRuns[] }` |
| `mergePR(repo, prNumber)` | void |

**Error**: `GitHubClientError`
**Layer**: `GitHubClientLive` — requires `OctokitClient`, `LalphConfig`

---

### PullRequestTracker
**File**: `services/PullRequestTracker.ts` | **Tag**: `PullRequestTracker`

Polls GitHub at configured interval. Emits events for new PRs, conflicts, CI failures, new comments.

| Method | Type |
|---|---|
| `eventStream` | `Stream<PullRequestEvent>` |

**Events emitted**: `PROpened`, `PRConflictDetected`, `PRCommentAdded`, `PRCIFailed`

**Internal state**: `HashSet<prId>` for known PRs, `HashMap<prId, conflictState>`, `HashMap<prId+sha, ciState>`. Only emits after first poll cycle (avoids flooding on startup).

**Error**: `PullRequestTrackerError`
**Layer**: `PullRequestTrackerLive` — requires `GitHubClient`, `AppRuntimeConfig`, `LalphConfig`

---

### AutoMerge
**File**: `services/AutoMerge.ts` | **Tag**: `AutoMerge`

Polls at configured interval. Merges PRs when CI passes and enough time has elapsed since last push.

| Method | Type |
|---|---|
| `eventStream` | `Stream<AutoMergeEvent>` |

**Events emitted**: `PRAutoMerged`

**Logic**: Tracks head SHA timestamps per PR. Waits `autoMergeWaitMinutes` after last push. Checks all CI checks complete and passed. Skips PRs with conflicts. Emits empty stream if `autoMergeEnabled` is false.

**Error**: `AutoMergeError`
**Layer**: `AutoMergeLive` — requires `GitHubClient`, `AppRuntimeConfig`, `LalphConfig`

---

### CommentTimer
**File**: `services/CommentTimer.ts` | **Tag**: `CommentTimer`

Per-PR timer management for comment-triggered issue state changes.

| Method | Signature | Description |
|---|---|---|
| `handleComment` | `(pr, comment) => Effect<void>` | Start/reset timer for PR |
| `shutdown` | `Effect<void>` | Interrupt all active timer fibers |

**Logic**: If comment contains trigger keyword → immediately move issue to Todo + set urgent + notify. Otherwise, reset timer (cancel previous fiber, start new one). On timeout → move to Todo + notify.

**Error**: `CommentTimerError`
**Layer**: `CommentTimerLive` — requires `TaskTracker`, `MessengerAdapter`, `BranchParser`, `AppRuntimeConfig`

---

### TaskTracker (interface)
**File**: `services/TaskTracker/TaskTracker.ts` | **Tag**: `TaskTracker`

Abstract interface for issue tracking. Two implementations selected at runtime via `TrackerLayerMap`.

| Method | Signature |
|---|---|
| `eventStream` | `Stream<TaskTrackerEvent>` |
| `moveToTodo(issueId)` | `Effect<void>` |
| `setPriorityUrgent(issueId)` | `Effect<void>` |
| `getIssue(issueId)` | `Effect<TrackerIssue>` |

**Events emitted**: `TaskCreated`, `TaskUpdated`
**Error**: `TaskTrackerError`

### LinearTracker (TaskTracker impl)
**File**: `services/TaskTracker/LinearTracker.ts`
- Polls Linear for issues updated since last poll
- Tracks state in `HashMap<issueId, stateName>`
- `moveToTodo` resolves "Todo" workflow state ID, updates issue
- `setPriorityUrgent` sets priority to 1
- **Layer**: `LinearTrackerLive` — requires `LinearSdkClient`, `AppRuntimeConfig`

### GitHubIssueTracker (TaskTracker impl)
**File**: `services/TaskTracker/GitHubIssueTracker.ts`
- Polls GitHub issues updated since last poll
- Issue ID format: `owner/repo#number`
- `moveToTodo` adds "todo" label
- `setPriorityUrgent` adds "urgent" label
- **Layer**: `GitHubIssueTrackerLive` — requires `GitHubClient`, `OctokitClient`, `AppRuntimeConfig`, `LalphConfig`

---

### TrackerLayerMap
**File**: `services/TrackerLayerMap.ts` | **Tag**: `TrackerLayerMap`

`LayerMap.Service` for runtime selection of TaskTracker implementation.

```ts
TrackerLayerMap.get("linear")  // → Layer<TaskTracker> using LinearTracker
TrackerLayerMap.get("github")  // → Layer<TaskTracker> using GitHubIssueTracker
```

---

### PlanOverviewUploader (interface)
**File**: `services/PlanOverviewUploader.ts` | **Tag**: `PlanOverviewUploader`

Uploads plan overview files to a hosting backend and returns a viewable URL. Takes spec files directly (not pre-generated HTML) — each implementation handles formatting internally. Two implementations selected at runtime via `PlanOverviewUploaderMap`.

| Method | Signature |
|---|---|
| `upload({ files, description })` | `Effect<{ url: string }, PlanOverviewUploaderError>` |

**Error**: `PlanOverviewUploaderError`

### GistPlanOverviewUploaderLive (PlanOverviewUploader impl)
- Generates HTML via `generateSpecHtml`, uploads as `spec.html` in a private gist via `OctokitClient.createGist`
- Constructs viewable URL via `htmlpreview.github.io`
- **Layer**: `GistPlanOverviewUploaderLive` — requires `OctokitClient`

### TelegraphPlanOverviewUploaderLive (PlanOverviewUploader impl, default)
- Creates anonymous Telegraph account on construction via `POST /createAccount`
- Converts spec files directly to Telegraph nodes via `specFilesToTelegraphNodes` (Mermaid→PlantUML→kroki.io SVG images, heading downgrade h1/h2→h3 h3+→h4)
- Uploads pages via `POST /createPage` with UUID title for unguessable URL
- Returns `telegra.ph` URL
- **Layer**: `TelegraphPlanOverviewUploaderLive` — requires `HttpClient`

---

### PlanOverviewUploaderMap
**File**: `services/PlanOverviewUploaderMap.ts` | **Tag**: `PlanOverviewUploaderMap`

`LayerMap.Service` for runtime selection of PlanOverviewUploader implementation.

```ts
PlanOverviewUploaderMap.get("gist")        // → Layer<PlanOverviewUploader> using GistPlanOverviewUploaderLive
PlanOverviewUploaderMap.get("telegraph")   // → Layer<PlanOverviewUploader> using TelegraphPlanOverviewUploaderLive (default)
```

---

### LinearSdkClient
**File**: `services/LinearSdkClient.ts` | **Tag**: `LinearSdkClient`

Wraps `@linear/sdk` LinearClient. Refreshes if token changes.

| Method | Description |
|---|---|
| `listIssues({ since })` | Issues updated since timestamp |
| `getIssue({ id })` | Single issue |
| `listWorkflowStates()` | All workflow states |
| `updateIssue({ id, stateId })` | Change issue state |
| `updateIssuePriority({ id, priority })` | Change priority |

**Error**: `LinearSdkClientError`
**Layer**: `LinearSdkClientLive` — requires `LalphConfig`

---

### ProjectStore
**File**: `services/ProjectStore.ts` | **Tag**: `ProjectStore`

Reads/writes lalph project configuration from `~/.lalph/config/settings.projects`.

| Method | Signature | Description |
|---|---|---|
| `listProjects` | `Effect<ReadonlyArray<LalphProject>>` | Returns only enabled projects |
| `getProject(id)` | `Effect<LalphProject>` | Finds project by id |
| `createProject(data)` | `Effect<LalphProject>` | Appends new project and persists to file |

**Error**: `ProjectStoreError`
**Layer**: `ProjectStoreLive` — requires `AppContext`, `FileSystem`, `Path`

---

### PlanSession
**File**: `services/PlanSession.ts` | **Tag**: `PlanSession`

Manages interactive Claude plan sessions via subprocess.

| Method | Signature | Description |
|---|---|---|
| `start(planText, projectId?)` | `Effect<void>` | Save plan to temp file, spawn `lalph plan` subprocess. If projectId provided, sends it to stdin before plan text. |
| `answer(text)` | `Effect<void>` | Send plain text answer to stdin (for ask_user responses) |
| `sendFollowUp(text)` | `Effect<void>` | Send `{ type: "follow_up", text }` to stdin |
| `interrupt(text)` | `Effect<void>` | Send `{ type: "shim_interrupt", text }` to stdin |
| `approve` | `Effect<void>` | Send `{ type: "shim_approve" }` to stdin |
| `reject` | `Effect<void>` | Send `{ type: "shim_abort" }` and close session |
| `isActive` | `Effect<boolean>` | Check if session is running |
| `isIdle` | `Effect<boolean>` | True after `result` message, false when Claude is working |
| `readFeatureAnalysis` | `Effect<{ analysis, services, test }>` | Read `.specs/analysis.md`, `services.mmd`, `test.md` |
| `readBugAnalysis` | `Effect<{ analysis }>` | Read `.specs/analysis.md` |
| `readRefactorAnalysis` | `Effect<{ analysis }>` | Read `.specs/analysis.md` |
| `readDefaultAnalysis` | `Effect<{ analysis }>` | Read `.specs/analysis.md` |
| `events` | `Stream<PlanEvent>` | Stream of plan events |

**Plan Events**:
- `PlanTextOutput` — Claude's text response (split for Telegram)
- `PlanQuestion` — Claude asking a question (via ask_user MCP tool)
- `PlanSpecCreated` — New spec file written under `.specs/`
- `PlanSpecUpdated` — Existing spec file re-written
- `PlanAnalysisReady` — `.specs/analysis.md` written
- `PlanAwaitingInput` — Claude finished its turn (result message received), awaiting user input
- `PlanCompleted` — Process exited successfully
- `PlanFailed` — Process failed or stream error

**Implementation**: Saves plan to `~/.lalph/config/tmp/plan-{timestamp}.md`. Spawns process via `Command`. Parses NDJSON stdout. Handles `shim_ready` → responds `shim_start`. Parses `assistant` messages for `text` and `tool_use` (ask_user) content blocks. On `result` message → emits `PlanSpecReady`. Three daemon fibers: stdout parser, stderr logger, exit waiter.

**Error**: `PlanSessionError`
**Layer**: `PlanSessionLive` (scoped) — requires `PlanCommandBuilder` (from Main.ts), `AppContext`

---

### BranchParser
**File**: `lib/BranchParser.ts` | **Tag**: `BranchParser`

Extracts issue ID from PR branch name.

| Method | Signature |
|---|---|
| `resolveIssueId(pr)` | `Option<string>` |

**Patterns** (tried in order):
1. Linear prefix: `ABC-123/...` → `ABC-123`
2. Linear anywhere: `feature/ABC-123-desc` → `ABC-123`
3. GitHub prefix: `#42/...` or `42/...` → `42`
4. GitHub anywhere: `feature/#42-desc` → `42`

Returns Linear IDs as-is, GitHub as `repo#number`.

**Layer**: `BranchParserLive`

---

## Event Types (`Events.ts`)

All events are `Data.TaggedEnum` (tagged unions with `_tag` discriminator).

| Event | Fields | Emitted By |
|---|---|---|
| `TaskCreated` | `issue: TrackerIssue` | TaskTracker |
| `TaskUpdated` | `issue: TrackerIssue, previousState: string` | TaskTracker |
| `PROpened` | `pr: GitHubPullRequest` | PullRequestTracker |
| `PRConflictDetected` | `pr: GitHubPullRequest` | PullRequestTracker |
| `PRCommentAdded` | `pr: GitHubPullRequest, comment: GitHubComment` | PullRequestTracker |
| `PRCIFailed` | `pr: GitHubPullRequest, failedChecks: string[]` | PullRequestTracker |
| `PRAutoMerged` | `pr: GitHubPullRequest` | AutoMerge |

**Unions**: `PullRequestEvent`, `TaskTrackerEvent`, `AutoMergeEvent`, `AppEvent` (all of them)

---

## Schemas

| File | Types |
|---|---|
| `schemas/GitHubSchemas.ts` | `GitHubRepo`, `GitHubPullRequest` (id, number, title, state, headRef, headSha, hasConflicts, repo), `GitHubComment` |
| `schemas/TrackerSchemas.ts` | `TrackerIssue` (id, title, state, url, createdAt, updatedAt) |
| `schemas/ProjectSchemas.ts` | `LalphProject` (id, enabled, targetBranch: Option\<string\>, concurrency, gitFlow: "pr"\|"commit", reviewAgent) |
| `schemas/CredentialSchemas.ts` | `LalphGithubToken` ({ token }), `LalphLinearToken` ({ token, expiresAt, refreshToken }) |
| `schemas/LinearSchemas.ts` | `LinearIssueNode`, `LinearWorkflowState` |

---

## Utilities

### SpecHtmlGenerator (`lib/SpecHtmlGenerator.ts`)
- `generateSpecHtml(files)` — Pure function that takes `ReadonlyArray<{ name, content, mermaid }>` and returns a self-contained HTML string with Mermaid.js CDN for client-side diagram rendering, basic markdown-to-HTML conversion, and HTML escaping

### MermaidToPlantUml (`lib/MermaidToPlantUml.ts`)
- `mermaidToPlantUml(mermaid)` — Pure function converting Mermaid class diagram syntax to PlantUML. Handles `classDiagram`→`@startuml/@enduml`, `~generics~`→`<generics>`, method return type formatting, relationship arrows

### TelegraphMarkdown (`lib/TelegraphMarkdown.ts`)
- `markdownToTelegraphNodes(md)` — Pure function converting markdown directly to Telegraph Node array. Two-phase parser: block-level state machine (code fences with `br` tags for line breaks instead of `\n`, headings h1/h2→h3 h3+→h4, HR, ul/ol lists, blockquotes, paragraphs) + recursive inline scanner (code, links, bold, italic, strikethrough). Skips lossy HTML intermediate step
- `specFilesToTelegraphNodes(files)` — Converts `ReadonlyArray<SpecFile>` to Telegraph Node array. Adds file name as h3 heading per file, converts mermaid files to kroki.io PlantUML SVG `<img>` nodes (via `mermaidToPlantUml` + zlib deflate + base64url encoding), parses markdown files with `markdownToTelegraphNodes`

### TelegramFormatter (`lib/TelegramFormatter.ts`)
- `markdownToTelegramHtml(md)` — Converts markdown to Telegram HTML subset (bold, italic, code, links, headers)
- `splitMessage(text)` — Chunks for Telegram's 4096 char limit (splits on paragraphs, then lines)

### StreamJsonParser (`lib/StreamJsonParser.ts`)
- Decodes NDJSON from Claude's `--output-format stream-json`
- Types: `StreamJsonMessage`, `ContentBlock`, `Question`, `AskUserQuestionInput`
- `parseNdjsonMessages` for stream processing

---

## Claude Shim (`src/shim/`)

SDK-based `claude` binary replacement bundled directly in this package (previously `@qotaq/claude-shim`). Streams NDJSON to stdout for `PlanSession` to parse. Uses MCP tool for `AskUserQuestion` instead of hooks.

### Files

| File | Purpose |
|---|---|
| `shim/main.ts` | Core shim program — `shimProgram` effect, `ShimDeps`/`ClaudeQuery` services, `ShimError`, `ShimConfig` |
| `shim/bin.ts` | Entry point — wires Node stdin/stdout/stderr and `query` from `@anthropic-ai/claude-agent-sdk` |
| `shim/parseArgs.ts` | CLI argument parsing — extracts prompt, `--dangerously-skip-permissions`, `--model` |
| `shim/schemas.ts` | Effect `Schema` definitions for shim control messages (`shim_start`, `shim_abort`, `shim_interrupt`, `shim_approve`, `follow_up`) |

### Services

- **ShimDeps** (`Context.Tag`) — IO dependencies: `args`, `stdin` (Stream), `stdout`/`stderr` (Sink)
- **ClaudeQuery** (`Context.Tag`) — creates `Query` instances via `@anthropic-ai/claude-agent-sdk`
- **ShimConfig** — `Config.all` reading `REAL_CLAUDE_PATH` and `CLAUDE_MODEL` env vars

### Protocol

1. Shim writes `{ type: "shim_ready" }` to stdout
2. Parent sends `{ type: "shim_start" }` or `{ type: "shim_abort" }` via stdin
3. SDK query streams `SDKMessage` NDJSON to stdout
4. Parent can send `follow_up`, `shim_interrupt`, `shim_approve`, `shim_abort` via stdin

---

## ChatMachine (`services/ChatMachine.ts`)

State machine for the interactive Telegram chat flow, built with `@effect/experimental/Machine`.

### Architecture
- Uses `Machine.make` with `Machine.procedures` — actor model with `send()` for requests
- Services captured at init via closures — all handlers have `R = never`
- State is `Data.TaggedEnum<ChatState>` — all sub-state folded into state variants (no Refs)
- All handlers return `[void, newState]` (resolved response + next state)

### Exports
- Button label constants: `PLAN_BUTTON_LABEL`, `ABORT_BUTTON_LABEL`, `APPROVE_BUTTON_LABEL`, etc.
- Keyboards: `IDLE_KEYBOARD`
- Request types: `UserMessage`, `PlanTextOutput`, `PlanQuestionReceived`, `PlanSpecCreatedReq`, `PlanSpecUpdatedReq`, `PlanAnalysisReadyReq`, `PlanAwaitingInputReq`, `PlanCompletedReq`, `PlanFailedReq`
- State types: `ChatState`, `ReadyFlags`
- Machine: `chatMachine`

### State (`ChatState`)

| State | Data | Keyboard |
|---|---|---|
| `Idle` | — | [Plan, New project] |
| `SelectingProject` | — | (inline: project buttons + New project + Abort) |
| `SelectingPlanType` | `projectId` | (inline: Feature/Bug/Refactor/Other/Abort) |
| `CollectingPlan` | `projectId`, `planType`, `buffer` | [Done, Abort] |
| `SessionRunning` | `projectId`, `planType`, `pendingAnswerCount`, `pendingOptionLabels`, `answersBuffer`, `awaitingFreeTextAnswer`, `lastQuestionMessage`, `readyFlags`, `analysisFollowUpSent` | [Abort] |
| `AwaitingFollowUpDecision` | `projectId`, `planType`, `message`, `readyFlags`, `analysisFollowUpSent` | (inline: Buffer/Interrupt/Discard/Abort) |
| `SpecReady` | `projectId`, `planType`, `readyFlags`, `analysisFollowUpSent` | [Approve, Abort] |
| `CreatingProject` | `step`, `data`, `continueWithPlan` | [Abort] |

### Request Handlers (procedures)

**UserMessage** — dispatches on `state._tag`:
- **Idle** + "Plan" → list projects: 0 → error, 1 → auto-select `SelectingPlanType`, >1 → `SelectingProject`
- **Idle** + "New project" → `CreatingProject` (continueWithPlan=false)
- **SelectingProject** + project → `SelectingPlanType`; + "New project" → `CreatingProject` (continueWithPlan=true); + "Abort" → `Idle`
- **SelectingPlanType** + plan type → `CollectingPlan`; + "Abort" → `Idle`
- **CollectingPlan** + text → buffer; + "Done" → `SessionRunning` (start session); + "Abort" → `Idle`
- **SessionRunning** + "Abort" → reject + `Idle`; + option → buffer answer (submit when all answered); + "Custom answer" → free-text mode; + text (idle) → sendFollowUp; + text (busy) → `AwaitingFollowUpDecision`
- **AwaitingFollowUpDecision** + "Buffer"/"Interrupt"/"Discard" → handle + `SessionRunning`; + "Abort" → reject + `Idle`
- **SpecReady** + "Approve" → approve + `SessionRunning`; + "Abort" → reject + `Idle`; + text → sendFollowUp or `AwaitingFollowUpDecision`
- **CreatingProject** → 5-step wizard (Name→Concurrency→TargetBranch→GitFlow→ReviewAgent) → createProject → if continueWithPlan: `SelectingPlanType`, else: `Idle`

**PlanTextOutput** → send text chunks (no state change)
**PlanQuestionReceived** → update pendingAnswerCount/labels, send question UI (SessionRunning only)
**PlanSpecCreatedReq/PlanSpecUpdatedReq** → set spec flag, maybe send analysis follow-up, check all ready → maybe `SpecReady`
**PlanAnalysisReadyReq** → set analysis flag, check all ready → maybe `SpecReady`
**PlanAwaitingInputReq** → set idle flag, check all ready → maybe `SpecReady`
**PlanCompletedReq** / **PlanFailedReq** → `Idle`

### Spec File Delivery (`sendSpecFiles`)
When spec + analysis + idle `ReadyFlags` are all met, reads spec files from `PlanSession`, uploads via `PlanOverviewUploader.upload`, and sends the returned URL via Telegram. Falls back to chunked raw Telegram text if upload fails.

**Dependencies** (captured at init): `MessengerAdapter`, `PlanSession`, `ProjectStore`, `PlanOverviewUploader`

---

## EventLoop (`services/EventLoop.ts`)

### Layer Composition (`MainLayer`)
Wires all service layers together. Requires `AppRuntimeConfig`, `TelegramConfigStore`, and `PlanCommandBuilder` externally.

### Event Loop (`runEventLoop`)
Boots `chatMachine`, bridges external streams, and dispatches PR/task events.

1. Boots `Machine.boot(chatMachine)` → actor
2. Bridges `MessengerAdapter.incomingMessages` → `actor.send(UserMessage)` (daemon fiber)
3. Bridges `PlanSession.events` → `actor.send(PlanSpecCreatedReq | PlanTextOutput | ...)` (daemon fiber)
4. Merges `PullRequestTracker` + `AutoMerge` + `TaskTracker` event streams → `dispatchEvent` (daemon fiber)
5. Blocks with `Effect.never` to keep Machine scope alive

### App Event Dispatching (`dispatchEvent`)

- `TaskCreated` → Telegram notification with link
- `TaskUpdated` → Notification with old → new state
- `PROpened` → Notification
- `PRConflictDetected` → Post GitHub comment + move issue to Todo + set urgent + Telegram notification
- `PRCommentAdded` → Route to `CommentTimer.handleComment`
- `PRCIFailed` → Post GitHub comment + move to Todo + set urgent + Telegram with failed check names
- `PRAutoMerged` → Notification

### Stream Architecture

Three daemon fibers run concurrently:
1. **Incoming messages** → `UserMessage` requests to machine actor
2. **Plan events** → plan request types to machine actor
3. **Polling stream**: merges `PullRequestTracker` + `AutoMerge` + `TaskTracker` event streams → dispatches notifications

---

## Layer Wiring (dependency graph)

```
AppContext
  └─> LalphConfig (watches credential files)
        ├─> OctokitClient (GitHub token)
        │     └─> GitHubClient
        │           ├─> PullRequestTracker (polls PRs)
        │           ├─> AutoMerge (polls + merges)
        │           └─> GitHubIssueTracker
        ├─> LinearSdkClient (Linear token)
        │     └─> LinearTracker
        ├─> TrackerLayerMap (selects Linear or GitHub tracker)
        │     └─> TaskTracker (provided dynamically)
        ├─> PlanOverviewUploaderMap (selects Gist or Telegraph uploader)
        │     └─> PlanOverviewUploader (provided dynamically)
FetchHttpClient (provided in Main.ts for Telegraph HTTP requests)
        └─> TelegramConfig
              └─> TelegramAdapter → MessengerAdapter

AppRuntimeConfig (from CLI args)
BranchParser (standalone)
CommentTimer (requires TaskTracker, MessengerAdapter, BranchParser, AppRuntimeConfig)
PlanSession (requires PlanCommandBuilder, AppContext)
ProjectStore (requires AppContext, FileSystem, Path)

EventLoop (requires all of the above + PlanOverviewUploader for spec hosting)
```

---

## Data Flow

```
GitHub/Linear Polling ──────────────────────┐
  PullRequestTracker.eventStream            │
  AutoMerge.eventStream                     ├──> merged stream ──> dispatchEvent ──> Telegram
  TaskTracker.eventStream                   │                  ──> GitHub comments
                                            │                  ──> Issue state changes
                                            ┘

Telegram User Input ────────────────────────┐
  MessengerAdapter.incomingMessages         │
    ├─ Plan workflow (collect → start)      ├──> PlanSession subprocess (claude-shim)
    ├─ Answers (for ask_user questions)     │      ├─ stdout NDJSON → PlanEvent stream
    ├─ Buffer / Interrupt / Omit / Abort    │      └─ stdin control messages
    └─ Approve                              │
                                            ┘
```
