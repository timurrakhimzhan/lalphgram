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
      return `\

Now analyze the spec you just wrote. Create the following files:

1. \`.specs/analysis.md\` — high-level design summary in plain text:
   - What services are added or changed and why
   - Layer composition: what depends on what
   - Key design decisions and trade-offs

2. \`.specs/services.mmd\` — a Mermaid classDiagram showing all new/changed service interfaces with their methods and return types. Use \`<<interface>>\` annotations. Show dependency arrows between services. Use \`~\` for generics (e.g. \`Effect~void, MyError~\`).

3. \`.specs/test.md\` — detailed test plan using AAA (Arrange/Act/Assert) structure. For each test case:
   - **Name**: descriptive test name in \`it("...")\` style
   - **Arrange**: what mocks, layers, and initial state to set up
   - **Act**: the single effect/function call under test
   - **Assert**: expected outcome and why this case matters

Be extremely concise. Sacrifice grammar for the sake of concision.
Do NOT display file contents in your response. The system will send them to the user.`
    case "Bug":
      return `\
Now analyze the spec you just wrote. Write your analysis to \`.specs/analysis.md\` covering:
- Root cause analysis
- A failing TDD test case that reproduces the bug
- Resolution strategy
- Regression prevention measures`
    case "Refactor":
      return `\
Now analyze the spec you just wrote. Write your analysis to \`.specs/analysis.md\` covering:
- Current state vs target state
- Migration steps in order
- Risk assessment for each step
- Test impact: which tests need updating?`
    default:
      return `\
Now analyze the spec you just wrote. Write your analysis to \`.specs/analysis.md\` covering:
- Scope summary
- Implementation approach
- Dependencies and prerequisites
- Test strategy`
  }
}
