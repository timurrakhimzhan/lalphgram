import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { extractIssueId } from "../src/lib/BranchParser.js"

describe("BranchParser", () => {
  it("extracts Linear ID from prefix pattern", () => {
    // Arrange
    const branch = "ABC-123/add-feature"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("ABC-123"))
  })

  it("extracts Linear ID from anywhere in branch", () => {
    // Arrange
    const branch = "feature/ABC-456-some-description"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("ABC-456"))
  })

  it("extracts GitHub issue number from prefix pattern", () => {
    // Arrange
    const branch = "123-fix-bug"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("123"))
  })

  it("extracts GitHub issue number from anywhere in branch", () => {
    // Arrange
    const branch = "feature/456-add-tests"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("456"))
  })

  it("returns None for branch with no issue ID", () => {
    // Arrange
    const branch = "main"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.none())
  })

  it("prefers Linear ID over GitHub issue number", () => {
    // Arrange
    const branch = "RAK-32/123-description"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("RAK-32"))
  })

  it("handles complex branch names", () => {
    // Arrange
    const branch = "user/RAK-99-implement-feature"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("RAK-99"))
  })
})
