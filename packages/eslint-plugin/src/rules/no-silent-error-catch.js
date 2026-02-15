/**
 * ESLint rule to prevent silently swallowing errors in catchTag/catchTags handlers.
 *
 * When catching an error, the handler must either:
 * - Log the error (Effect.logError, Effect.logWarning, Effect.logFatal)
 * - Map to another error (Effect.fail)
 *
 * Silently returning Effect.succeed/Effect.void without logging is not allowed.
 */

/** @type {import('eslint').Rule.RuleModule} */
export const noSilentErrorCatch = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require error logging in catchTag/catchTags handlers unless mapping to another error with Effect.fail",
      recommended: true
    },
    messages: {
      noSilentCatch:
        "Error caught by {{ method }} must be logged (Effect.logError/logWarning) or mapped to another error (Effect.fail). Don't silently swallow errors."
    },
    schema: []
  },

  create(context) {
    const ALLOWED_METHODS = ["logError", "logWarning", "logFatal", "fail"]

    /**
     * Recursively check if a node contains Effect.logError/logWarning/logFatal/fail
     */
    function containsLogOrFail(node) {
      if (!node || typeof node !== "object") return false

      // Check: Effect.<allowedMethod>
      if (
        node.type === "MemberExpression" &&
        node.object &&
        node.object.type === "Identifier" &&
        node.object.name === "Effect" &&
        node.property &&
        node.property.type === "Identifier" &&
        ALLOWED_METHODS.includes(node.property.name)
      ) {
        return true
      }

      // Recurse into child nodes
      for (const key of Object.keys(node)) {
        if (key === "parent") continue
        const child = node[key]
        if (child && typeof child === "object") {
          if (Array.isArray(child)) {
            for (const item of child) {
              if (item && typeof item.type === "string" && containsLogOrFail(item)) {
                return true
              }
            }
          } else if (typeof child.type === "string") {
            if (containsLogOrFail(child)) {
              return true
            }
          }
        }
      }

      return false
    }

    function checkHandler(handler, methodName, reportNode) {
      if (!handler) return
      if (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") return

      if (!containsLogOrFail(handler.body)) {
        context.report({
          node: reportNode,
          messageId: "noSilentCatch",
          data: { method: methodName }
        })
      }
    }

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== "MemberExpression") return
        const prop = callee.property
        if (prop.type !== "Identifier") return

        if (prop.name === "catchTag") {
          // Effect.catchTag("Tag", handler) — handler is last function arg
          const args = node.arguments
          if (args.length >= 2) {
            const handler = args[args.length - 1]
            checkHandler(handler, "catchTag", node)
          }
        } else if (prop.name === "catchTags") {
          // Effect.catchTags({ Tag: handler, ... }) — handlers are in the object
          const objArg = node.arguments.find((a) => a.type === "ObjectExpression")
          if (objArg) {
            for (const property of objArg.properties) {
              if (property.type === "Property" && property.value) {
                checkHandler(property.value, "catchTags", property)
              }
            }
          }
        }
      }
    }
  }
}
