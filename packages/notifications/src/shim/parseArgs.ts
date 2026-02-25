/**
 * CLI argument parsing for claude-shim.
 * @since 1.0.0
 */

export interface ParsedArgs {
  readonly prompt: string
  readonly dangerouslySkipPermissions: boolean
  readonly model: string | null
}

export function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  let dangerouslySkipPermissions = false
  let prompt = ""
  let model: string | null = null
  let skipNext = false

  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const arg = args[i]!
    if (arg === "--dangerously-skip-permissions") {
      dangerouslySkipPermissions = true
    } else if (arg === "--output-format") {
      skipNext = true
    } else if (arg === "--model") {
      model = args[i + 1] ?? null
      skipNext = true
    } else if (arg === "--verbose" || arg === "-p" || arg === "--print") {
      // ignored — SDK handles output format and verbosity
    } else if (arg === "--") {
      // everything after -- is the prompt
      prompt = args.slice(i + 1).join(" ")
      break
    } else if (!arg.startsWith("-")) {
      prompt = arg
    }
  }

  return { prompt, dangerouslySkipPermissions, model }
}
