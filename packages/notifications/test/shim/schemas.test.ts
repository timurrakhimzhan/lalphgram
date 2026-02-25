import { describe, expect, it } from "@effect/vitest"
import { Either } from "effect"
import { decodeShimMessage } from "../../src/shim/schemas.js"

describe("decodeShimMessage", () => {
  it("decodes shim_start without text", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_start" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_start" })
    }
  })

  it("decodes shim_start with text", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_start", text: "Go ahead!" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_start", text: "Go ahead!" })
    }
  })

  it("decodes shim_abort", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_abort" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_abort" })
    }
  })

  it("decodes shim_interrupt without text", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_interrupt" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_interrupt" })
    }
  })

  it("decodes shim_interrupt with text", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_interrupt", text: "urgent" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_interrupt", text: "urgent" })
    }
  })

  it("decodes shim_approve without text", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_approve" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_approve" })
    }
  })

  it("decodes shim_approve with text", () => {
    // Arrange
    const line = JSON.stringify({ type: "shim_approve", text: "Looks good, build it" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "shim_approve", text: "Looks good, build it" })
    }
  })

  it("decodes follow_up", () => {
    // Arrange
    const line = JSON.stringify({ type: "follow_up", text: "also do X" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right).toEqual({ type: "follow_up", text: "also do X" })
    }
  })

  it("returns Left for unknown type", () => {
    // Arrange
    const line = JSON.stringify({ type: "unknown_thing" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })

  it("returns Left for invalid JSON", () => {
    // Act
    const result = decodeShimMessage("not json")

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })

  it("returns Left for empty string", () => {
    // Act
    const result = decodeShimMessage("")

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })

  it("returns Left for follow_up missing text field", () => {
    // Arrange
    const line = JSON.stringify({ type: "follow_up" })

    // Act
    const result = decodeShimMessage(line)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })
})
