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
3. Build `PlanCommandBuilder` — spawns `lalph plan` with PATH shimming to use claude-shim
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

### PlanSession
**File**: `services/PlanSession.ts` | **Tag**: `PlanSession`

Manages interactive Claude plan sessions via subprocess.

| Method | Signature | Description |
|---|---|---|
| `start(planText)` | `Effect<void>` | Save plan to temp file, spawn `lalph plan` subprocess |
| `answer(text)` | `Effect<void>` | Send plain text answer to stdin (for ask_user responses) |
| `sendFollowUp(text)` | `Effect<void>` | Send `{ type: "follow_up", text }` to stdin |
| `interrupt(text)` | `Effect<void>` | Send `{ type: "shim_interrupt", text }` to stdin |
| `approve` | `Effect<void>` | Send `{ type: "shim_approve" }` to stdin |
| `reject` | `Effect<void>` | Send `{ type: "shim_abort" }` and close session |
| `isActive` | `Effect<boolean>` | Check if session is running |
| `isIdle` | `Effect<boolean>` | True after `result` message, false when Claude is working |
| `events` | `Stream<PlanEvent>` | Stream of plan events |

**Plan Events**:
- `PlanTextOutput` — Claude's text response (split for Telegram)
- `PlanQuestion` — Claude asking a question (via ask_user MCP tool)
- `PlanSpecReady` — Spec complete, awaiting approval
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
| `schemas/CredentialSchemas.ts` | `LalphGithubToken` ({ token }), `LalphLinearToken` ({ token, expiresAt, refreshToken }) |
| `schemas/LinearSchemas.ts` | `LinearIssueNode`, `LinearWorkflowState` |

---

## Utilities

### TelegramFormatter (`lib/TelegramFormatter.ts`)
- `markdownToTelegramHtml(md)` — Converts markdown to Telegram HTML subset (bold, italic, code, links, headers)
- `splitMessage(text)` — Chunks for Telegram's 4096 char limit (splits on paragraphs, then lines)

### StreamJsonParser (`lib/StreamJsonParser.ts`)
- Decodes NDJSON from Claude's `--output-format stream-json`
- Types: `StreamJsonMessage`, `ContentBlock`, `Question`, `AskUserQuestionInput`
- `parseNdjsonMessages` for stream processing

---

## EventLoop (`services/EventLoop.ts`)

### State Machine (`ChatState`)
Single `Ref<ChatState>` discriminated union with 7 states:

| State | Data | Reply Keyboard |
|---|---|---|
| `Idle` | — | [Plan] |
| `SelectingPlanType` | — | (inline: Feature/Bug/Refactor/Other/Abort) |
| `CollectingPlan` | `planType`, `buffer` | [Done, Abort] |
| `SessionRunning` | — | [Abort] |
| `AwaitingAnswers` | `remaining` | [Abort] |
| `AwaitingFollowUpDecision` | `message` | (inline: Buffer/Interrupt/Omit/Abort) |
| `SpecReady` | — | [Approve, Abort] |

### State Transitions (incoming messages)

- **Idle** + "Plan" → `SelectingPlanType`
- **SelectingPlanType** + plan type → `CollectingPlan`; + "Abort" → `Idle`
- **CollectingPlan** + text → buffer it; + "Done" → `SessionRunning` (start session); + "Abort" → `Idle`
- **SessionRunning** + "Abort" → reject + `Idle`; + text → `AwaitingFollowUpDecision`
- **AwaitingAnswers** + text → answer, decrement; if 0 remaining → `SessionRunning`; + "Abort" → reject + `Idle`
- **AwaitingFollowUpDecision** + "Buffer"/"Interrupt"/"Omit" → handle + `SessionRunning`; + "Abort" → reject + `Idle`
- **SpecReady** + "Approve" → approve + `SessionRunning`; + "Abort" → reject + `Idle`; + text → `AwaitingFollowUpDecision`

### State Transitions (plan events)

- `PlanTextOutput` → send text (no state change)
- `PlanQuestion` → `AwaitingAnswers(N)` + "Please answer all N questions above."
- `PlanSpecReady` → `SpecReady`
- `PlanCompleted` / `PlanFailed` → `Idle` (with Plan button restored)

### App Event Dispatching

- `TaskCreated` → Telegram notification with link
- `TaskUpdated` → Notification with old → new state
- `PROpened` → Notification
- `PRConflictDetected` → Post GitHub comment + move issue to Todo + set urgent + Telegram notification
- `PRCommentAdded` → Route to `CommentTimer.handleComment`
- `PRCIFailed` → Post GitHub comment + move to Todo + set urgent + Telegram with failed check names
- `PRAutoMerged` → Notification

### Stream Architecture

Two forked streams run concurrently:
1. **Plan stream** (daemon fiber): merges `incomingMessages` + `planSession.events` → handles interactively
2. **Polling stream** (main): merges `PullRequestTracker` + `AutoMerge` + `TaskTracker` event streams → dispatches notifications

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
        └─> TelegramConfig
              └─> TelegramAdapter → MessengerAdapter

AppRuntimeConfig (from CLI args)
BranchParser (standalone)
CommentTimer (requires TaskTracker, MessengerAdapter, BranchParser, AppRuntimeConfig)
PlanSession (requires PlanCommandBuilder, AppContext)

EventLoop (requires all of the above)
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
