/**
 * ESLint rule to prefer get.result() over get() in runtime.atom contexts
 * When inside Effect.gen or runtime.atom, use get.result() for automatic unwrapping
 */

/** @type {import('eslint').Rule.RuleModule} */
export const preferGetResult = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Prefer get.result() over get() in Effect/runtime.atom contexts",
      recommended: true
    },
    messages: {
      preferGetResult: "Inside Effect.gen/runtime.atom, prefer get.result(atom) over get(atom) for automatic Result unwrapping."
    },
    schema: []
  },

  create(context) {
    // Track if we're inside an Effect.gen or runtime.atom context
    let effectContextDepth = 0

    function isEffectContext(node) {
      // Check for Effect.gen(function* () { ... })
      if (
        node.callee &&
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Effect" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "gen"
      ) {
        return true
      }

      // Check for runtime.atom((get) => Effect.gen(...))
      if (
        node.callee &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "atom"
      ) {
        return true
      }

      return false
    }

    return {
      CallExpression(node) {
        if (isEffectContext(node)) {
          effectContextDepth++
        }

        // Check for get(atom) calls inside Effect context
        if (
          effectContextDepth > 0 &&
          node.callee.type === "Identifier" &&
          node.callee.name === "get" &&
          node.arguments.length > 0
        ) {
          // Check if this is NOT get.result (which would be a MemberExpression)
          // get(atom) is just Identifier "get", get.result(atom) would be MemberExpression
          const parent = node.parent

          // Allow get() if immediately used with yield* or in a pipe with Result operations
          // This is a simple heuristic - we warn on standalone get() calls
          if (
            parent &&
            parent.type !== "YieldExpression" &&
            parent.type !== "CallExpression" // not inside pipe or map
          ) {
            context.report({
              node,
              messageId: "preferGetResult"
            })
          }
        }
      },

      "CallExpression:exit"(node) {
        if (isEffectContext(node)) {
          effectContextDepth--
        }
      }
    }
  }
}
