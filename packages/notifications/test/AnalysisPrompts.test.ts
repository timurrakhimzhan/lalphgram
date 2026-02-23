import { describe, expect, it } from "@effect/vitest"
import { getAnalysisPrompt } from "../src/lib/AnalysisPrompts.js"

describe("getAnalysisPrompt", () => {
  it("returns Feature-specific prompt", () => {
    const prompt = getAnalysisPrompt("Feature")
    expect(prompt).toContain("services")
    expect(prompt).toContain("analysis.md")
    expect(prompt).toContain("interfaces.mmd")
    expect(prompt).toContain("tests.md")
  })

  it("returns Bug-specific prompt", () => {
    const prompt = getAnalysisPrompt("Bug")
    expect(prompt).toContain("Root cause")
    expect(prompt).toContain("TDD test case")
    expect(prompt).toContain("analysis.md")
  })

  it("returns Refactor-specific prompt", () => {
    const prompt = getAnalysisPrompt("Refactor")
    expect(prompt).toContain("Current state vs target state")
    expect(prompt).toContain("Migration steps")
    expect(prompt).toContain("analysis.md")
  })

  it("returns Other/default prompt for unknown plan type", () => {
    const prompt = getAnalysisPrompt("Other")
    expect(prompt).toContain("Scope summary")
    expect(prompt).toContain("Implementation approach")
    expect(prompt).toContain("analysis.md")
  })

  it("returns default prompt for unrecognized plan type", () => {
    const prompt = getAnalysisPrompt("SomethingElse")
    expect(prompt).toContain("Scope summary")
    expect(prompt).toContain("analysis.md")
  })
})
