import { mergeConfig, type UserConfigExport } from "vitest/config"
import shared from "./vitest.shared.js"

const config: UserConfigExport = {
  test: {
    projects: ["packages/lalphgram", "packages/eslint-plugin"]
  }
}

export default mergeConfig(shared, config)
