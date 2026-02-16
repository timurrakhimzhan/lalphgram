/**
 * ESLint rule to disallow module-level functions (with parameters) that return Effects, Layers, or Streams.
 *
 * Effectful logic belongs as methods on Context.Tag services. Layers should be constants.
 * Pure functions and Effect constants (no parameters) are allowed.
 *
 * Bad:
 *   export const readLalphConfig = (dir: string) => Effect.gen(function*() { ... })
 *   export const makeMainLayer = (creds: Credentials) => { ... Layer.succeed(...) ... }
 *
 * Good:
 *   export const MainLayer = Layer.mergeAll(...)
 *   export const findLalphDirectory = Effect.gen(function*() { ... })
 */

const EFFECT_NAMESPACES = new Set(["Effect", "Layer", "Stream", "Schedule"])

const EFFECT_APIS = new Set([
  // Effect
  "gen",
  "tryPromise",
  "succeed",
  "fail",
  "sync",
  "promise",
  "map",
  "flatMap",
  "tap",
  "forEach",
  "all",
  "provide",
  "merge",
  "catchTag",
  "catchTags",
  "catchAll",
  "mapError",
  "orElseSucceed",
  "annotateLogs",
  "ensuring",
  "asVoid",
  "suspend",
  "runForEach",
  "repeatEffect",
  "repeatEffectWithSchedule",
  // Layer
  "effect",
  "scoped",
  "mergeAll",
  // Stream
  "fromIterable",
  "filterMap",
  "take",
  "runCollect",
  "runDrain",
  // Schedule
  "spaced"
])

/** @type {import('eslint').Rule.RuleModule} */
export const noEffectfulFunction = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow module-level functions (with parameters) whose body uses Effect/Layer/Stream/Schedule APIs. Effectful logic belongs as service methods or Layer constants.",
      recommended: true
    },
    messages: {
      noEffectfulFunction:
        "Module-level function '{{ name }}' with parameters must not use Effect/Layer/Stream/Schedule APIs. Move this logic into a service method or make it a constant (no parameters)."
    },
    schema: []
  },

  create(context) {
    /**
     * Check if a node contains Effect/Layer/Stream/Schedule API calls
     */
    function containsEffectApis(node) {
      if (!node) return false

      if (
        node.type === "MemberExpression"
        && node.object.type === "Identifier"
        && EFFECT_NAMESPACES.has(node.object.name)
        && node.property.type === "Identifier"
        && EFFECT_APIS.has(node.property.name)
      ) {
        return true
      }

      for (const key of Object.keys(node)) {
        if (key === "parent") continue
        const child = node[key]
        if (child && typeof child === "object") {
          if (Array.isArray(child)) {
            for (const item of child) {
              if (item && typeof item.type === "string" && containsEffectApis(item)) {
                return true
              }
            }
          } else if (typeof child.type === "string") {
            if (containsEffectApis(child)) {
              return true
            }
          }
        }
      }

      return false
    }

    /**
     * Check if a function node has at least one parameter
     */
    function hasParameters(node) {
      return node.params && node.params.length > 0
    }

    /**
     * Check if a node is a function (arrow or regular function expression)
     */
    function isFunctionNode(node) {
      return (
        node.type === "ArrowFunctionExpression"
        || node.type === "FunctionExpression"
        || node.type === "FunctionDeclaration"
      )
    }

    /**
     * Unwrap curried functions: (a) => (b) => body — returns innermost body
     * and checks if any level has parameters
     */
    function unwrapCurriedFunction(node) {
      let current = node
      let totalParams = 0
      while (isFunctionNode(current)) {
        totalParams += current.params?.length ?? 0
        if (
          current.body
          && current.body.type !== "BlockStatement"
          && isFunctionNode(current.body)
        ) {
          current = current.body
        } else {
          break
        }
      }
      return { body: current.body ?? current, totalParams }
    }

    /**
     * Check if a node is inside a Layer.effect/Layer.succeed/Layer.scoped call,
     * Effect.gen body, or .of({...}) call
     */
    function isInsideExemptContext(node) {
      let current = node.parent
      while (current) {
        if (current.type === "CallExpression") {
          const callee = current.callee
          // Layer.effect(...), Layer.succeed(...), Layer.scoped(...)
          if (
            callee.type === "MemberExpression"
            && callee.object.type === "Identifier"
            && callee.object.name === "Layer"
            && callee.property.type === "Identifier"
            && ["effect", "succeed", "scoped"].includes(callee.property.name)
          ) {
            return true
          }
          // Effect.gen(...)
          if (
            callee.type === "MemberExpression"
            && callee.object.type === "Identifier"
            && callee.object.name === "Effect"
            && callee.property.type === "Identifier"
            && callee.property.name === "gen"
          ) {
            return true
          }
          // *.of({...})
          if (
            callee.type === "MemberExpression"
            && callee.property.type === "Identifier"
            && callee.property.name === "of"
          ) {
            return true
          }
        }
        current = current.parent
      }
      return false
    }

    return {
      VariableDeclaration(node) {
        // Only check module-level declarations
        if (node.parent.type !== "Program" && node.parent.type !== "ExportNamedDeclaration") {
          return
        }

        for (const declarator of node.declarations) {
          if (declarator.type !== "VariableDeclarator") continue
          if (!declarator.id || declarator.id.type !== "Identifier") continue

          const init = declarator.init
          if (!init) continue

          if (!isFunctionNode(init)) continue

          const { body, totalParams } = unwrapCurriedFunction(init)
          if (totalParams === 0) continue

          if (isInsideExemptContext(declarator)) continue

          if (containsEffectApis(body)) {
            context.report({
              node: declarator,
              messageId: "noEffectfulFunction",
              data: { name: declarator.id.name }
            })
          }
        }
      },

      FunctionDeclaration(node) {
        // Only check module-level declarations
        if (
          node.parent.type !== "Program"
          && node.parent.type !== "ExportNamedDeclaration"
        ) {
          return
        }

        if (!hasParameters(node)) return
        if (!node.id) return

        if (isInsideExemptContext(node)) return

        if (containsEffectApis(node.body)) {
          context.report({
            node,
            messageId: "noEffectfulFunction",
            data: { name: node.id.name }
          })
        }
      }
    }
  }
}
