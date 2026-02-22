#!/usr/bin/env node
/**
 * Entry point for the claude-shim binary.
 * @since 1.0.0
 */
import { query } from "@anthropic-ai/claude-agent-sdk"
import { NodeRuntime } from "@effect/platform-node"
import * as NodeSink from "@effect/platform-node/NodeSink"
import * as NodeStream from "@effect/platform-node/NodeStream"
import { Effect, Layer } from "effect"
import { ClaudeQuery, ShimDeps, ShimError, shimProgram } from "./main.js"

shimProgram.pipe(
  Effect.tapError(() =>
    Effect.sync(() => {
      process.exitCode = 1
    })
  ),
  Effect.catchAll((err) => Effect.logError("claude-shim failed", err)),
  Effect.provide(Layer.mergeAll(
    Layer.succeed(ShimDeps, {
      args: process.argv.slice(2),
      stdin: NodeStream.stdin,
      stdout: NodeSink.stdout,
      stderr: NodeSink.stderr
    }),
    Layer.succeed(ClaudeQuery, {
      create: (params) =>
        Effect.try({
          try: () => query(params),
          catch: (err) => new ShimError({ message: "Failed to create query", cause: err })
        })
    })
  )),
  NodeRuntime.runMain
)
