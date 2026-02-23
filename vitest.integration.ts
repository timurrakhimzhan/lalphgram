import * as path from "node:path"
import { defineConfig } from "vitest/config"

const alias = (name: string) => {
  const target = process.env.TEST_DIST !== undefined ? "dist/dist/esm" : "src"
  return ({
    [`@template/${name}/test`]: path.join(__dirname, "packages", name, "test"),
    [`@template/${name}`]: path.join(__dirname, "packages", name, target)
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
      ...alias("notifications")
    }
  }
})
