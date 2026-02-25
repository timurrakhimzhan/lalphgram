import * as path from "node:path"
import { defineConfig } from "vitest/config"

const alias = (pkg: string, dir: string) => {
  const target = process.env.TEST_DIST !== undefined ? "dist/dist/esm" : "src"
  return ({
    [`@qotaq/${pkg}/test`]: path.join(__dirname, "packages", dir, "test"),
    [`@qotaq/${pkg}`]: path.join(__dirname, "packages", dir, target)
  })
}

export default defineConfig({
  esbuild: {
    target: "es2020"
  },
  optimizeDeps: {
    exclude: ["bun:sqlite"]
  },
  test: {
    setupFiles: [path.join(__dirname, "setupTests.ts")],
    include: ["packages/*/test/integration/**/*.integration.test.ts"],
    exclude: ["**/.claude/worktrees/**"],
    testTimeout: 30_000,
    sequence: {
      concurrent: false
    },
    alias: {
      ...alias("lalphgram", "notifications")
    }
  }
})
