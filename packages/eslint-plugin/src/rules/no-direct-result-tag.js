/**
 * ESLint rule to discourage direct Result manipulation
 * Prefer using get.result() in Effect atoms or Result.match/builder patterns
 *
 * Exception: Atom.writable setter functions are allowed to use Result checks
 * because they don't have access to get.result()
 */

/** @type {import('eslint').Rule.RuleModule} */
export const noDirectResultTag = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Discourage direct Result manipulation, prefer get.result() or Result.match/builder",
      recommended: true
    },
    messages: {
      noDirectTag:
        "Avoid direct ._tag access on Result. Use get.result() in Effect atoms, Result.match(), or Result.builder() instead.",
      useGetResult: "Use get.result(atom) instead of get(atom) with manual Result checks.",
      noResultMethod:
        "Avoid Result.{{ method }}() on get() results. Use get.result() in Effect atoms or Result.builder() pattern."
    },
    schema: []
  },

  create(context) {
    // Track variables that come from get() calls
    const getResultVariables = new Set()
    // Track Atom.writable setter function nodes (second argument)
    const writableSetterNodes = new Set()

    /**
     * Check if a node is inside an Atom.writable setter function
     */
    function isInsideWritableSetter(node) {
      let current = node
      while (current) {
        if (writableSetterNodes.has(current)) {
          return true
        }
        current = current.parent
      }
      return false
    }

    return {
      // Track Atom.writable calls and mark their setter functions
      "CallExpression"(node) {
        // Check if this is Atom.writable(read, write)
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Atom" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "writable" &&
          node.arguments.length >= 2
        ) {
          // Mark the second argument (setter function) as allowed
          const setterArg = node.arguments[1]
          if (
            setterArg.type === "ArrowFunctionExpression" ||
            setterArg.type === "FunctionExpression"
          ) {
            writableSetterNodes.add(setterArg)
          }
        }
      },

      // Track: const result = get(someAtom)
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === "CallExpression" &&
          node.id.type === "Identifier"
        ) {
          const callee = node.init.callee

          // get(atom)
          if (callee.type === "Identifier" && callee.name === "get") {
            getResultVariables.add(node.id.name)
          }

          // ctx.get(atom), registry.get(atom), etc.
          if (
            callee.type === "MemberExpression" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "get"
          ) {
            getResultVariables.add(node.id.name)
          }
        }
      },

      // Detect: result._tag
      MemberExpression(node) {
        if (
          node.property.type === "Identifier" &&
          node.property.name === "_tag" &&
          node.object.type === "Identifier" &&
          getResultVariables.has(node.object.name)
        ) {
          // Skip if inside Atom.writable setter
          if (isInsideWritableSetter(node)) {
            return
          }
          context.report({
            node,
            messageId: "useGetResult"
          })
        }
      },

      // Detect: Result.isSuccess(result), Result.isFailure(result), etc.
      "CallExpression:exit"(node) {
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Result" &&
          node.callee.property.type === "Identifier" &&
          ["isSuccess", "isFailure", "isInitial", "isWaiting"].includes(node.callee.property.name)
        ) {
          // Check if argument is a variable from get()
          const arg = node.arguments[0]
          if (
            arg &&
            arg.type === "Identifier" &&
            getResultVariables.has(arg.name)
          ) {
            // Skip if inside Atom.writable setter
            if (isInsideWritableSetter(node)) {
              return
            }
            context.report({
              node,
              messageId: "noResultMethod",
              data: { method: node.callee.property.name }
            })
          }
        }
      }
    }
  }
}
