#!/usr/bin/env node
/**
 * Entry point for the claude-shim binary.
 * @since 1.0.0
 */
import { query } from "@anthropic-ai/claude-agent-sdk"
import * as NodeStream from "@effect/platform-node/NodeStream"
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { ClaudeQuery, ShimDeps, ShimError, shimProgram } from "./main.js"

shimProgram.pipe(
  Effect.catchAll((err) =>
    Effect.gen(function*() {
      yield* Effect.logError("claude-shim failed", err)
      process.exitCode = 1
    })),
  Effect.provide(Layer.mergeAll(
    Layer.succeed(ShimDeps, {
      args: process.argv.slice(2),
      stdin: NodeStream.stdin,
      stdout: process.stdout,
      stderr: process.stderr
    }),
    Layer.succeed(ClaudeQuery, {
      create: (params) => Effect.try({
        try: () => query(params),
        catch: (err) => new ShimError({ message: "Failed to create query", cause: err })
      })
    })
  )),
  NodeRuntime.runMain
)
