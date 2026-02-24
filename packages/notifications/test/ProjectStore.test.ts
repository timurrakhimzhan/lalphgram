import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { LalphProject } from "../src/schemas/ProjectSchemas.js"
import { AppContext } from "../src/services/AppContext.js"
import { ProjectStore, ProjectStoreLive } from "../src/services/ProjectStore.js"

let testCounter = 0
const makeTestDir = () => {
  testCounter++
  return `/tmp/.lalph-project-store-test-${testCounter}-${Date.now()}`
}

const makeTestLayer = (testDir: string) =>
  ProjectStoreLive.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(AppContext, AppContext.of({ projectRoot: "/tmp", configDir: testDir })),
      NodeContext.layer
    ))
  )

const writeProjectsFile = (testDir: string, projects: ReadonlyArray<Record<string, unknown>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(testDir, { recursive: true })
    yield* fs.writeFileString(`${testDir}/settings.projects`, JSON.stringify(projects))
  }).pipe(Effect.provide(NodeContext.layer))

describe("ProjectStore", () => {
  it.effect("listProjects returns empty array when file does not exist", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const projects = yield* store.listProjects

        // Assert
        expect(projects).toEqual([])
      }).pipe(Effect.provide(testLayer))
    }))

  it.effect("listProjects returns only enabled projects", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      yield* writeProjectsFile(testDir, [
        {
          id: "proj-a",
          enabled: true,
          targetBranch: { _tag: "None" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        },
        {
          id: "proj-b",
          enabled: false,
          targetBranch: { _tag: "None" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        },
        {
          id: "proj-c",
          enabled: true,
          targetBranch: { _tag: "Some", value: "main" },
          concurrency: 2,
          gitFlow: "commit",
          reviewAgent: true
        }
      ])
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const projects = yield* store.listProjects

        // Assert
        expect(projects).toHaveLength(2)
        expect(projects[0]!.id).toBe("proj-a")
        expect(projects[1]!.id).toBe("proj-c")
      }).pipe(Effect.provide(testLayer))
    }))

  it.effect("getProject returns project by id", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      yield* writeProjectsFile(testDir, [
        {
          id: "proj-a",
          enabled: true,
          targetBranch: { _tag: "None" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        },
        {
          id: "proj-b",
          enabled: true,
          targetBranch: { _tag: "Some", value: "develop" },
          concurrency: 3,
          gitFlow: "commit",
          reviewAgent: true
        }
      ])
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const project = yield* store.getProject("proj-b")

        // Assert
        expect(project.id).toBe("proj-b")
        expect(project.concurrency).toBe(3)
        expect(project.gitFlow).toBe("commit")
        expect(project.reviewAgent).toBe(true)
        expect(Option.isSome(project.targetBranch)).toBe(true)
      }).pipe(Effect.provide(testLayer))
    }))

  it.effect("getProject fails when project not found", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      yield* writeProjectsFile(testDir, [
        {
          id: "proj-a",
          enabled: true,
          targetBranch: { _tag: "None" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        }
      ])
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const result = yield* store.getProject("nonexistent").pipe(Effect.flip)

        // Assert
        expect(result.message).toBe("Project not found: nonexistent")
      }).pipe(Effect.provide(testLayer))
    }))

  it.effect("createProject appends to existing projects and writes file", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      yield* writeProjectsFile(testDir, [
        {
          id: "proj-a",
          enabled: true,
          targetBranch: { _tag: "None" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        }
      ])
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const newProject = yield* store.createProject({
          id: "proj-new",
          targetBranch: Option.some("main"),
          concurrency: 2,
          gitFlow: "commit",
          reviewAgent: true
        })

        // Assert
        expect(newProject).toBeInstanceOf(LalphProject)
        expect(newProject.id).toBe("proj-new")
        expect(newProject.enabled).toBe(true)
        expect(newProject.concurrency).toBe(2)
        expect(newProject.gitFlow).toBe("commit")
        expect(newProject.reviewAgent).toBe(true)
        expect(Option.getOrNull(newProject.targetBranch)).toBe("main")

        // Verify persistence — re-read
        const allProjects = yield* store.listProjects
        expect(allProjects).toHaveLength(2)
        expect(allProjects[1]!.id).toBe("proj-new")
      }).pipe(Effect.provide(testLayer))
    }))

  it.effect("createProject creates file when none exists", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const newProject = yield* store.createProject({
          id: "first-project",
          targetBranch: Option.none(),
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        })

        // Assert
        expect(newProject.id).toBe("first-project")
        const projects = yield* store.listProjects
        expect(projects).toHaveLength(1)
      }).pipe(Effect.provide(testLayer))
    }))

  it.effect("listProjects decodes targetBranch as Option", () =>
    Effect.gen(function*() {
      // Arrange
      const testDir = makeTestDir()
      yield* writeProjectsFile(testDir, [
        {
          id: "proj-a",
          enabled: true,
          targetBranch: { _tag: "Some", value: "main" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        },
        {
          id: "proj-b",
          enabled: true,
          targetBranch: { _tag: "None" },
          concurrency: 1,
          gitFlow: "pr",
          reviewAgent: false
        }
      ])
      const testLayer = makeTestLayer(testDir)

      yield* Effect.gen(function*() {
        const store = yield* ProjectStore

        // Act
        const projects = yield* store.listProjects

        // Assert
        expect(Option.isSome(projects[0]!.targetBranch)).toBe(true)
        expect(Option.getOrNull(projects[0]!.targetBranch)).toBe("main")
        expect(Option.isNone(projects[1]!.targetBranch)).toBe(true)
      }).pipe(Effect.provide(testLayer))
    }))
})
