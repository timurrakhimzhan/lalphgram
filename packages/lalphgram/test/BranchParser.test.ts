import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { BranchParser, BranchParserLive, extractIssueId } from "../src/lib/BranchParser.js"
import { GitHubPullRequest } from "../src/schemas/GitHubSchemas.js"

const makePR = (headRef: string, repo = "owner/my-repo") =>
  new GitHubPullRequest({
    id: 100,
    number: 1,
    title: "Test PR",
    state: "open",
    html_url: "https://github.com/owner/my-repo/pull/1",
    headRef,
    headSha: "abc123",
    hasConflicts: false,
    repo
  })

describe("extractIssueId", () => {
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

  it("extracts GitHub issue number from #42/description prefix", () => {
    // Arrange
    const branch = "#42/fix-bug"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("42"))
  })

  it("extracts GitHub issue number from 42/description prefix", () => {
    // Arrange
    const branch = "42/fix-bug"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("42"))
  })

  it("extracts GitHub issue number with # from anywhere in branch", () => {
    // Arrange
    const branch = "feature/#42/description"

    // Act
    const result = extractIssueId(branch)

    // Assert
    expect(result).toStrictEqual(Option.some("42"))
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

describe("BranchParser.resolveIssueId", () => {
  it.effect("returns Linear ID as-is for Linear branches", () =>
    Effect.gen(function*() {
      // Arrange
      const parser = yield* BranchParser
      const pr = makePR("ABC-123/feature")

      // Act
      const result = parser.resolveIssueId(pr)

      // Assert
      expect(result).toStrictEqual(Option.some("ABC-123"))
    }).pipe(Effect.provide(BranchParserLive)))

  it.effect("constructs owner/repo#number for GitHub issue branches with #", () =>
    Effect.gen(function*() {
      // Arrange
      const parser = yield* BranchParser
      const pr = makePR("#42/fix-something", "octocat/hello-world")

      // Act
      const result = parser.resolveIssueId(pr)

      // Assert
      expect(result).toStrictEqual(Option.some("octocat/hello-world#42"))
    }).pipe(Effect.provide(BranchParserLive)))

  it.effect("constructs owner/repo#number for GitHub issue branches without #", () =>
    Effect.gen(function*() {
      // Arrange
      const parser = yield* BranchParser
      const pr = makePR("42/fix-something", "octocat/hello-world")

      // Act
      const result = parser.resolveIssueId(pr)

      // Assert
      expect(result).toStrictEqual(Option.some("octocat/hello-world#42"))
    }).pipe(Effect.provide(BranchParserLive)))

  it.effect("returns None when no issue ID found", () =>
    Effect.gen(function*() {
      // Arrange
      const parser = yield* BranchParser
      const pr = makePR("main")

      // Act
      const result = parser.resolveIssueId(pr)

      // Assert
      expect(result).toStrictEqual(Option.none())
    }).pipe(Effect.provide(BranchParserLive)))
})
