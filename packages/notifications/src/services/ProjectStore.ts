/**
 * Project store — reads/writes lalph project configuration
 * @since 1.0.0
 */
import { FileSystem, Path } from "@effect/platform"
import type { Option } from "effect"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { LalphProject } from "../schemas/ProjectSchemas.js"
import { AppContext } from "./AppContext.js"

/**
 * @since 1.0.0
 * @category errors
 */
export class ProjectStoreError extends Data.TaggedError("ProjectStoreError")<{
  message: string
  cause: unknown
}> {}

/**
 * @since 1.0.0
 * @category services
 */
export interface ProjectStoreService {
  readonly listProjects: Effect.Effect<ReadonlyArray<LalphProject>, ProjectStoreError>
  readonly getProject: (id: string) => Effect.Effect<LalphProject, ProjectStoreError>
  readonly createProject: (data: {
    readonly id: string
    readonly targetBranch: Option.Option<string>
    readonly concurrency: number
    readonly gitFlow: "pr" | "commit"
    readonly reviewAgent: boolean
    readonly labelFilter?: string
    readonly autoMergeLabel?: string
  }) => Effect.Effect<LalphProject, ProjectStoreError>
}

/**
 * @since 1.0.0
 * @category context
 */
export class ProjectStore extends Context.Tag("ProjectStore")<
  ProjectStore,
  ProjectStoreService
>() {}

const ProjectsArray = Schema.Array(LalphProject)

/**
 * @since 1.0.0
 * @category layers
 */
export const ProjectStoreLive = Layer.effect(
  ProjectStore,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const appContext = yield* AppContext

    const filePath = pathService.join(appContext.configDir, "settings.projects")

    const readProjects = Effect.gen(function*() {
      const exists = yield* fs.exists(filePath).pipe(
        Effect.mapError((err) =>
          new ProjectStoreError({ message: `Failed to check projects file: ${String(err)}`, cause: err })
        )
      )
      if (!exists) {
        const empty: ReadonlyArray<typeof LalphProject.Type> = []
        return empty
      }

      const content = yield* fs.readFileString(filePath).pipe(
        Effect.mapError((err) =>
          new ProjectStoreError({ message: `Failed to read projects file: ${String(err)}`, cause: err })
        )
      )
      const json = yield* Effect.try({
        try: () => JSON.parse(content),
        catch: (err) => new ProjectStoreError({ message: `Failed to parse projects JSON: ${String(err)}`, cause: err })
      })
      return yield* Schema.decodeUnknown(ProjectsArray)(json).pipe(
        Effect.mapError((err) =>
          new ProjectStoreError({ message: `Failed to decode projects: ${String(err)}`, cause: err })
        )
      )
    })

    const listProjects = readProjects.pipe(
      Effect.map((projects) => projects.filter((p) => p.enabled))
    )

    const getProject = (id: string) =>
      readProjects.pipe(
        Effect.flatMap((projects) => {
          const project = projects.find((p) => p.id === id)
          if (project == null) {
            return Effect.fail(new ProjectStoreError({ message: `Project not found: ${id}`, cause: null }))
          }
          return Effect.succeed(project)
        })
      )

    const createProject = (data: {
      readonly id: string
      readonly targetBranch: Option.Option<string>
      readonly concurrency: number
      readonly gitFlow: "pr" | "commit"
      readonly reviewAgent: boolean
      readonly labelFilter?: string
      readonly autoMergeLabel?: string
    }) =>
      Effect.gen(function*() {
        const allProjects = yield* readProjects
        const newProject = new LalphProject({
          id: data.id,
          enabled: true,
          targetBranch: data.targetBranch,
          concurrency: data.concurrency,
          gitFlow: data.gitFlow,
          reviewAgent: data.reviewAgent,
          ...(data.labelFilter != null ? { labelFilter: data.labelFilter } : {}),
          ...(data.autoMergeLabel != null ? { autoMergeLabel: data.autoMergeLabel } : {})
        })
        const updated = [...allProjects, newProject]
        const encoded = yield* Schema.encode(ProjectsArray)(updated).pipe(
          Effect.mapError((err) =>
            new ProjectStoreError({ message: `Failed to encode projects: ${String(err)}`, cause: err })
          )
        )
        yield* fs.makeDirectory(pathService.dirname(filePath), { recursive: true }).pipe(
          Effect.mapError((err) =>
            new ProjectStoreError({ message: `Failed to create config dir: ${String(err)}`, cause: err })
          )
        )
        yield* fs.writeFileString(filePath, JSON.stringify(encoded, null, 2)).pipe(
          Effect.mapError((err) =>
            new ProjectStoreError({ message: `Failed to write projects file: ${String(err)}`, cause: err })
          )
        )
        return newProject
      })

    return ProjectStore.of({ listProjects, getProject, createProject })
  })
)
