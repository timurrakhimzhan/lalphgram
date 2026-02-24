/**
 * Converts Mermaid class diagram syntax to PlantUML.
 * Pure function — no side effects or dependencies.
 * @since 1.0.0
 */

/**
 * Convert a Mermaid class diagram to PlantUML syntax.
 *
 * Handles:
 * - `classDiagram` → `@startuml` / `@enduml`
 * - `class Foo {` blocks (preserved)
 * - `<<interface>>` stereotypes (preserved)
 * - `~Type1, Type2~` generics → `<Type1, Type2>`
 * - `+method(params) ReturnType` → `+method(params): ReturnType`
 * - Relationship arrows pass through (`<|--`, `<|..`, `-->`, `..>`)
 * @since 1.0.0
 */
export const mermaidToPlantUml = (mermaid: string): string => {
  const lines = mermaid.split("\n")
  const output: Array<string> = []
  let insideClassBlock = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    // Skip empty lines — pass through
    if (line === "") {
      output.push("")
      continue
    }

    // classDiagram → @startuml
    if (line === "classDiagram") {
      output.push("@startuml")
      continue
    }

    // Convert generics: ~Type1, Type2~ → <Type1, Type2>
    const converted = line.replace(/~([^~]+)~/g, "<$1>")

    // Detect class block open: "class Foo {" or "class Foo<T> {"
    if (/^class\s+\S+.*\{$/.test(converted)) {
      insideClassBlock = true
      output.push(converted)
      continue
    }

    // Detect class block close
    if (converted === "}" && insideClassBlock) {
      insideClassBlock = false
      output.push("}")
      continue
    }

    // Inside a class block: convert member signatures
    if (insideClassBlock) {
      output.push(convertMember(converted))
      continue
    }

    // Outside class blocks — relationships, annotations, etc. pass through
    output.push(converted)
  }

  output.push("@enduml")
  return output.join("\n")
}

/**
 * Convert a single class member line.
 * Mermaid: `+method(params) ReturnType` → PlantUML: `+method(params): ReturnType`
 * Mermaid: `+field Type` → PlantUML: `+field: Type`
 * Stereotypes like `<<interface>>` pass through unchanged.
 */
const convertMember = (line: string): string => {
  // <<interface>> or <<abstract>> — pass through
  if (/^<<.+>>$/.test(line)) {
    return line
  }

  // Method with parentheses: +method(params) ReturnType
  const methodMatch = /^([+\-#~]?)(\w+)\(([^)]*)\)\s+(.+)$/.exec(line)
  if (methodMatch) {
    const [, visibility, name, params, returnType] = methodMatch
    return `${visibility}${name}(${params}): ${returnType}`
  }

  // Method with parentheses but no return type: +method(params)
  const methodNoReturn = /^([+\-#~]?)(\w+)\(([^)]*)\)$/.exec(line)
  if (methodNoReturn) {
    return line
  }

  // Field: +field Type (no parentheses, has a space separating name and type)
  const fieldMatch = /^([+\-#~]?)(\w+)\s+(.+)$/.exec(line)
  if (fieldMatch) {
    const [, visibility, name, type] = fieldMatch
    return `${visibility}${name}: ${type}`
  }

  return line
}
