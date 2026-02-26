# @qotaq/lalphgram

Event-driven notification service that bridges GitHub, Linear, and Telegram. Polls for PR and task changes, sends real-time Telegram alerts, auto-merges PRs, and manages interactive Claude plan sessions — all from a single CLI command.

## Install

```bash
npm i -g @qotaq/lalphgram
```

Or run directly:

```bash
npx @qotaq/lalphgram
```

## Prerequisites

- A [Telegram bot token](https://core.telegram.org/bots#how-do-i-create-a-bot) (you'll be prompted on first run)
- A GitHub personal access token stored in `~/.lalph/config/`
- (Optional) A Linear API token for issue tracking
- A `.lalph/` directory in your project root (lalph project config)

## Usage

```bash
lalphgram [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--interval <seconds>` | `30` | Poll interval for GitHub/Linear |
| `--keyword <word>` | `"urgent"` | Trigger keyword for comment timer |
| `--timer <seconds>` | `300` | Comment timer delay |

### First Run

On first launch, the CLI will:

1. Prompt for your **Telegram bot token** (stored in `~/.lalph/config/notify.telegram`)
2. Ask whether to enable **auto-merge** and configure wait time
3. Ask you to send a message to your bot to confirm the chat ID

After setup, the event loop starts automatically.

## What It Does

### Notifications

- **New PRs** — alerts when PRs are opened
- **Merge conflicts** — detects conflicts and posts a GitHub comment + Telegram alert
- **CI failures** — reports failed checks with names
- **New tasks** — notifies on Linear/GitHub issue creation and state changes
- **PR comments** — routes to configurable comment timer for issue triage

### Auto-Merge

When enabled, monitors PRs and merges them automatically once:
- All CI checks pass
- A configurable cooldown period has elapsed since the last push

### Interactive Plan Sessions

Manage Claude coding plans directly from Telegram:

1. Tap **Plan** → select project → choose plan type (Feature/Bug/Refactor/Other)
2. Describe the work → tap **Done**
3. Claude analyzes and produces spec files (architecture diagrams, test plans)
4. Review specs via Telegraph link → **Approve** or **Abort**
5. Ask follow-up questions or interrupt at any point

## Architecture

Built with [Effect-TS](https://effect.website) — services use `Context.Tag` for dependency injection, `Stream` for event processing, and `Layer` for composition. The entire system runs as a single long-lived process with concurrent polling fibers.

## License

MIT
