import { describe, expect, it } from "@effect/vitest"
import { mermaidToPlantUml } from "../src/lib/MermaidToPlantUml.js"

describe("mermaidToPlantUml", () => {
  it("converts classDiagram to @startuml/@enduml", () => {
    // Arrange
    const mermaid = `classDiagram
    class Foo {
    }`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("@startuml")
    expect(result).toContain("@enduml")
    expect(result).not.toContain("classDiagram")
  })

  it("preserves class blocks with methods and fields", () => {
    // Arrange
    const mermaid = `classDiagram
    class EventLoop {
        +runEventLoop() void
        -sendSpecFiles(planType: string) void
    }`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("+runEventLoop(): void")
    expect(result).toContain("-sendSpecFiles(planType: string): void")
  })

  it("preserves <<interface>> stereotypes", () => {
    // Arrange
    const mermaid = `classDiagram
    class MessengerAdapter {
        <<interface>>
        +sendMessage(msg) void
    }`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("<<interface>>")
    expect(result).toContain("+sendMessage(msg): void")
  })

  it("converts generic types from ~Type~ to <Type>", () => {
    // Arrange
    const mermaid = `classDiagram
    class OctokitGist {
        +files: Record~string, RawUrl~
    }`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("Record<string, RawUrl>")
    expect(result).not.toContain("~")
  })

  it("converts method return types with generics", () => {
    // Arrange
    const mermaid = `classDiagram
    class PlanSession {
        +readFeatureAnalysis() ~Effect, Error~
    }`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("+readFeatureAnalysis(): <Effect, Error>")
  })

  it("preserves relationship arrows", () => {
    // Arrange
    const mermaid = `classDiagram
    EventLoop --> OctokitClient : creates gist
    EventLoop --> MessengerAdapter : sends URL
    OctokitClient ..> OctokitGist : returns`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("EventLoop --> OctokitClient : creates gist")
    expect(result).toContain("EventLoop --> MessengerAdapter : sends URL")
    expect(result).toContain("OctokitClient ..> OctokitGist : returns")
  })

  it("converts field type notation", () => {
    // Arrange
    const mermaid = `classDiagram
    class OctokitGist {
        +id string
        +htmlUrl string
    }`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toContain("+id: string")
    expect(result).toContain("+htmlUrl: string")
  })

  it("handles a complete class diagram", () => {
    // Arrange
    const mermaid = `classDiagram
    class SpecHtmlGenerator {
        +generateSpecHtml(files: SpecFile[]) string
    }

    class OctokitClient {
        +createGist(params) OctokitGist
        +getAuthenticatedUser() OctokitUser
    }

    class EventLoop {
        +runEventLoop() void
        -sendSpecFiles(planType: string) void
        -readSpecFiles(planType: string) SpecFile[]
    }

    EventLoop --> OctokitClient : creates gist
    EventLoop --> SpecHtmlGenerator : generates HTML

    class OctokitGist {
        +id: string
        +htmlUrl: string
        +files: Record~string, RawUrl~
    }

    OctokitClient ..> OctokitGist : returns`

    // Act
    const result = mermaidToPlantUml(mermaid)

    // Assert
    expect(result).toMatch(/^@startuml/)
    expect(result).toMatch(/@enduml$/)
    expect(result).toContain("+generateSpecHtml(files: SpecFile[]): string")
    expect(result).toContain("+createGist(params): OctokitGist")
    expect(result).toContain("Record<string, RawUrl>")
    expect(result).toContain("EventLoop --> OctokitClient : creates gist")
    expect(result).toContain("OctokitClient ..> OctokitGist : returns")
  })
})
