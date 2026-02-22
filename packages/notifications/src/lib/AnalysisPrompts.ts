/**
 * Plan-type-specific analysis prompts for spec file follow-ups
 * @since 1.0.0
 */

/**
 * Returns an analysis prompt tailored to the given plan type.
 * The prompt instructs Claude to write analysis output to `.specs/analysis.md`.
 * @since 1.0.0
 * @category prompts
 */
export const getAnalysisPrompt = (planType: string): string => {
  switch (planType) {
    case "Feature":
      return [
        "Now analyze the spec you just wrote. Write your analysis to `.specs/analysis.md` covering:",
        "- System design: what services are added or changed?",
        "- Interfaces and type definitions",
        "- Layer composition and interconnections",
        "- Test strategy: what tests are needed and what do they verify?"
      ].join("\n")
    case "Bug":
      return [
        "Now analyze the spec you just wrote. Write your analysis to `.specs/analysis.md` covering:",
        "- Root cause analysis",
        "- A failing TDD test case that reproduces the bug",
        "- Resolution strategy",
        "- Regression prevention measures"
      ].join("\n")
    case "Refactor":
      return [
        "Now analyze the spec you just wrote. Write your analysis to `.specs/analysis.md` covering:",
        "- Current state vs target state",
        "- Migration steps in order",
        "- Risk assessment for each step",
        "- Test impact: which tests need updating?"
      ].join("\n")
    default:
      return [
        "Now analyze the spec you just wrote. Write your analysis to `.specs/analysis.md` covering:",
        "- Scope summary",
        "- Implementation approach",
        "- Dependencies and prerequisites",
        "- Test strategy"
      ].join("\n")
  }
}
