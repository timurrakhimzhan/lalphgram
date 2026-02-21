#!/usr/bin/env node
/**
 * Entry point for the claude-shim binary.
 * @since 1.0.0
 */
import { query } from "@anthropic-ai/claude-agent-sdk"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { ShimDeps, shimProgram } from "./main.js"

shimProgram.pipe(
  Effect.catchTag("ShimError", (err) =>
    Effect.gen(function*() {
      yield* Effect.logError("claude-shim failed", err)
      process.exitCode = 1
    })),
  Effect.provide(Layer.succeed(ShimDeps, {
    args: process.argv.slice(2),
    createQuery: query,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env
  })),
  NodeRuntime.runMain
)
