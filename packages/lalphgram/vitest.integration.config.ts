import { defineConfig } from "vitest/config"
import shared from "../../vitest.shared.js"

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    include: ["test/integration/**/*.test.ts"]
  }
})
