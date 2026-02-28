import { describe, expect, it } from "@effect/vitest"
import { parseArgs } from "../../src/shim/parseArgs.js"

describe("parseArgs", () => {
  it("extracts positional prompt", () => {
    // Arrange
    const args = ["Hello world"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("Hello world")
    expect(result.dangerouslySkipPermissions).toBe(false)
    expect(result.model).toBeNull()
  })

  it("detects --dangerously-skip-permissions", () => {
    // Arrange
    const args = ["--dangerously-skip-permissions", "Do something"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.dangerouslySkipPermissions).toBe(true)
    expect(result.prompt).toBe("Do something")
  })

  it("extracts --model value", () => {
    // Arrange
    const args = ["--model", "claude-opus-4-6", "Hello"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.model).toBe("claude-opus-4-6")
    expect(result.prompt).toBe("Hello")
  })

  it("skips --output-format and its value", () => {
    // Arrange
    const args = ["--output-format", "stream-json", "Hello"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("Hello")
  })

  it("skips -p, --print, and --verbose flags", () => {
    // Arrange
    const args = ["-p", "--verbose", "--print", "Hello"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("Hello")
  })

  it("handles -- separator for prompt", () => {
    // Arrange
    const args = ["--dangerously-skip-permissions", "--", "prompt", "text", "here"]

    // Act
    const result = parseArgs(args)

    // Assert
    expect(result.prompt).toBe("prompt text here")
    expect(result.dangerouslySkipPermissions).toBe(true)
  })
})
