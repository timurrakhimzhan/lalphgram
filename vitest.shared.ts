import * as path from "node:path"
import type { UserConfig } from "vitest/config"

const alias = (pkg: string, dir: string) => {
  const target = process.env.TEST_DIST !== undefined ? "dist/dist/esm" : "src"
  return ({
    [`@qotaq/${pkg}/test`]: path.join(__dirname, "packages", dir, "test"),
    [`@qotaq/${pkg}`]: path.join(__dirname, "packages", dir, target)
  })
}

// This is a workaround, see https://github.com/vitest-dev/vitest/issues/4744
const config: UserConfig = {
  esbuild: {
    target: "es2020"
  },
  optimizeDeps: {
    exclude: ["bun:sqlite"]
  },
  test: {
    setupFiles: [path.join(__dirname, "setupTests.ts")],
    fakeTimers: {
      toFake: undefined
    },
    sequence: {
      concurrent: true
    },
    include: ["test/**/*.test.ts"],
    exclude: ["**/.claude/worktrees/**"],
    alias: {
      ...alias("lalphgram", "notifications")
    }
  }
}

export default config
