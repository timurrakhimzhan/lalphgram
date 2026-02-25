/**
 * Custom ESLint plugin for template
 * @since 1.0.0
 */
import { noDirectResultTag } from "./rules/no-direct-result-tag.js"
import { preferGetResult } from "./rules/prefer-get-result.js"
import { enforceServiceOfMock } from "./rules/enforce-service-of-mock.js"
import { noCatchAllRecovery } from "./rules/no-catch-all-recovery.js"
import { noSilentErrorCatch } from "./rules/no-silent-error-catch.js"
import { noEffectfulFunction } from "./rules/no-effectful-function.js"

export const rules = {
  "no-direct-result-tag": noDirectResultTag,
  "prefer-get-result": preferGetResult,
  "enforce-service-of-mock": enforceServiceOfMock,
  "no-catch-all-recovery": noCatchAllRecovery,
  "no-silent-error-catch": noSilentErrorCatch,
  "no-effectful-function": noEffectfulFunction
}

export const configs = {
  recommended: {
    plugins: ["@qotaq"],
    rules: {
      "@qotaq/no-direct-result-tag": "warn",
      "@qotaq/prefer-get-result": "warn",
      "@qotaq/enforce-service-of-mock": "error"
    }
  }
}
