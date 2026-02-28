# @qotaq/lalphgram

Telegram interface for planning and managing [lalph](https://github.com/nicholasgriffintn/lalph) tasks with Claude Code. Draft specs, review architecture diagrams, and approve plans — all from your phone. Also includes PR notifications, auto-merge, and task tracking as extras.

[![npm](https://img.shields.io/npm/v/@qotaq/lalphgram)](https://www.npmjs.com/package/@qotaq/lalphgram)
[![GitHub](https://img.shields.io/github/license/timurrakhimzhan/lalphgram)](https://github.com/timurrakhimzhan/lalphgram)

## Install

```bash
npm i -g @qotaq/lalphgram
```

Or run directly:

```bash
npx @qotaq/lalphgram
```

## Prerequisites

- [lalph](https://github.com/nicholasgriffintn/lalph) set up in your project
- A [Telegram bot token](https://core.telegram.org/bots#how-do-i-create-a-bot) (you'll be prompted on first run)

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

### Interactive Plan Sessions

Manage Claude coding plans directly from Telegram:

1. Tap **Plan** → select project → choose plan type (Feature/Bug/Refactor/Other)
2. Describe the work → tap **Done**
3. Claude analyzes and produces spec files (architecture diagrams, test plans)
4. Review specs via Telegraph link → **Approve** or **Abort**
5. Ask follow-up questions or interrupt at any point

### Notifications

- **New PRs** — alerts when PRs are opened
- **Merge conflicts** — detects conflicts and posts a GitHub comment + Telegram alert
- **New tasks** — notifies on Linear/GitHub issue creation and state changes

### Auto-Merge

When enabled, monitors PRs and merges them automatically once:
- All CI checks pass
- A configurable cooldown period has elapsed since the last push

## Links

- [npm](https://www.npmjs.com/package/@qotaq/lalphgram)
- [GitHub](https://github.com/timurrakhimzhan/lalphgram)

## License

MIT
