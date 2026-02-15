/**
 * ESLint rule to prevent catchAll/catchAllDefect for recovery logic.
 *
 * catchAll is only allowed when the callback just logs (Effect.logError).
 * If the callback contains Effect.gen or other logic, it should use catchTag/catchTags instead.
 */

/** @type {import('eslint').Rule.RuleModule} */
export const noCatchAllRecovery = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow catchAll/catchAllDefect for recovery logic — use catchTag/catchTags instead. catchAll is only allowed for logging.",
      recommended: true
    },
    messages: {
      noCatchAllRecovery:
        "Don't use {{ method }} for recovery logic — use catchTag or catchTags instead. {{ method }} is only allowed when the handler just logs the error (e.g. Effect.logError)."
    },
    schema: []
  },

  create(context) {
    /**
     * Check if a node is just an Effect.logError call (or a pipe ending in logError).
     * Allowed patterns:
     *   - (error) => Effect.logError(...)
     *   - Effect.logError
     */
    function isLogOnly(node) {
      if (!node) return false

      // Direct reference: Effect.logError
      if (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        node.object.name === "Effect" &&
        node.property.type === "Identifier" &&
        node.property.name === "logError"
      ) {
        return true
      }

      // Arrow function: (error) => Effect.logError(...)
      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
        const body = node.body
        // Expression body: (e) => Effect.logError(...)
        if (body.type === "CallExpression") {
          return isEffectLogErrorCall(body)
        }
        // Block body: (e) => { return Effect.logError(...) }
        if (body.type === "BlockStatement" && body.body.length === 1) {
          const stmt = body.body[0]
          if (stmt.type === "ReturnStatement" && stmt.argument) {
            return isEffectLogErrorCall(stmt.argument)
          }
          if (stmt.type === "ExpressionStatement") {
            return isEffectLogErrorCall(stmt.expression)
          }
        }
        return false
      }

      return false
    }

    function isEffectLogErrorCall(node) {
      if (node.type !== "CallExpression") return false
      const callee = node.callee
      return (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "Effect" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "logError"
      )
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return
        const prop = node.callee.property
        if (prop.type !== "Identifier") return
        if (prop.name !== "catchAll" && prop.name !== "catchAllDefect") return

        const callback = node.arguments[0]
        if (!callback) return

        if (!isLogOnly(callback)) {
          context.report({
            node,
            messageId: "noCatchAllRecovery",
            data: { method: prop.name }
          })
        }
      }
    }
  }
}
