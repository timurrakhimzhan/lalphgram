/**
 * ESLint rule to enforce Service.of() for creating typed mocks in tests.
 *
 * Detects patterns like:
 *   Layer.succeed(SomeService, { method: vi.fn(...) })
 *
 * and requires instead:
 *   Layer.succeed(SomeService, SomeService.of({ method: vi.fn(...) }))
 *
 * Only triggers when the object literal contains vitest mocking (any `vi.*` usage).
 * This gives proper type inference without manual annotations.
 */

/** @type {import('eslint').Rule.RuleModule} */
export const enforceServiceOfMock = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce Service.of() for creating typed mocks instead of plain object literals in Layer.succeed",
      recommended: true
    },
    messages: {
      enforceServiceOf:
        "Use {{ service }}.of({ ... }) instead of a plain object literal. Service.of() gives you proper type inference for mocks."
    },
    schema: []
  },

  create(context) {
    /**
     * Recursively check if an AST node references `vi` anywhere
     * (vi.fn, vi.spyOn, vi.fn().mockReturnValue, etc.)
     */
    function containsVi(node) {
      if (!node) return false

      if (node.type === "Identifier" && node.name === "vi") {
        return true
      }

      if (node.type === "MemberExpression") {
        return containsVi(node.object) || containsVi(node.property)
      }

      if (node.type === "CallExpression") {
        return containsVi(node.callee) || node.arguments.some(containsVi)
      }

      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
        return containsVi(node.body)
      }

      if (node.type === "BlockStatement") {
        return node.body.some(containsVi)
      }

      if (node.type === "ReturnStatement") {
        return containsVi(node.argument)
      }

      if (node.type === "ExpressionStatement") {
        return containsVi(node.expression)
      }

      return false
    }

    return {
      CallExpression(node) {
        // Match: Layer.succeed(ServiceTag, <objectLiteral>)
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Layer" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "succeed" &&
          node.arguments.length === 2
        ) {
          const serviceArg = node.arguments[0]
          const implArg = node.arguments[1]

          // Only flag when the second argument is a plain object literal
          // that contains vitest mocking (any vi.* usage)
          if (
            implArg.type === "ObjectExpression" &&
            implArg.properties.some((prop) =>
              prop.type === "Property" && containsVi(prop.value)
            )
          ) {
            const serviceName = serviceArg.type === "Identifier"
              ? serviceArg.name
              : "Service"

            context.report({
              node: implArg,
              messageId: "enforceServiceOf",
              data: { service: serviceName }
            })
          }
        }
      }
    }
  }
}
