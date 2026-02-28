/**
 * Project store — reads/writes lalph project configuration
 * @since 1.0.0
 */
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform"
import type { Option } from "effect"
import { Context, Data, Effect, Layer, Queue, Schema, Stream } from "effect"
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

// Arrow down escape sequence for Prompt.select navigation
const ARROW_DOWN = "\x1b[B"

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
    const executor = yield* CommandExecutor.CommandExecutor

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
        const encoder = new TextEncoder()
        const answers: Array<string> = [
          data.id,
          String(data.concurrency),
          data.targetBranch._tag === "Some" ? data.targetBranch.value : "",
          data.gitFlow === "commit" ? ARROW_DOWN : "",
          data.reviewAgent ? "" : "0",
          data.labelFilter ?? "",
          data.autoMergeLabel ?? ""
        ]

        const cmd = Command.make("lalph", "projects", "add").pipe(
          Command.workingDirectory(appContext.projectRoot),
          Command.stdout("pipe"),
          Command.stderr("pipe"),
          Command.stdin("pipe")
        )

        yield* Effect.scoped(
          Effect.gen(function*() {
            const process = yield* Command.start(cmd).pipe(
              Effect.provideService(CommandExecutor.CommandExecutor, executor)
            )

            // Queue-based stdin: send answer only when stdout shows a prompt ("?")
            const stdinQueue = yield* Queue.unbounded<Uint8Array>()
            yield* Stream.fromQueue(stdinQueue).pipe(
              Stream.run(process.stdin),
              Effect.forkDaemon
            )

            let answerIndex = 0
            let waitingForCompletion = false
            yield* process.stdout.pipe(
              Stream.map((chunk) => new TextDecoder().decode(chunk)),
              Stream.tap((text) => {
                if (waitingForCompletion) {
                  // Wait for "✔" (prompt accepted) before looking for next prompt
                  if (text.includes("\u2714") || text.includes("✔")) {
                    waitingForCompletion = false
                  }
                  return Effect.void
                }
                if (text.includes("?") && answerIndex < answers.length) {
                  const answer = answers[answerIndex] ?? ""
                  answerIndex++
                  waitingForCompletion = true
                  return Queue.offer(stdinQueue, encoder.encode(answer + "\n")).pipe(
                    Effect.tap(() =>
                      Effect.log("Sent answer to prompt").pipe(
                        Effect.annotateLogs({
                          answerIndex: String(answerIndex),
                          answer: answer.length > 0 ? answer : "(enter)"
                        })
                      )
                    )
                  )
                }
                return Effect.void
              }),
              Stream.runDrain,
              Effect.forkDaemon
            )

            // Drain stderr so the process doesn't block when pipe buffer fills
            const stderrChunks: Array<string> = []
            yield* process.stderr.pipe(
              Stream.map((chunk) => new TextDecoder().decode(chunk)),
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  stderrChunks.push(chunk)
                })
              ),
              Stream.runDrain,
              Effect.forkDaemon
            )

            const exitCode = yield* process.exitCode
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new ProjectStoreError({
                  message: `lalph projects add failed (exit ${exitCode}): ${stderrChunks.join("")}`,
                  cause: null
                })
              )
            }
          })
        ).pipe(
          Effect.mapError((err) =>
            err instanceof ProjectStoreError
              ? err
              : new ProjectStoreError({ message: `Failed to create project: ${String(err)}`, cause: err })
          )
        )

        yield* Effect.log("Project created via lalph projects add").pipe(
          Effect.annotateLogs({ projectId: data.id })
        )

        return new LalphProject({
          id: data.id,
          enabled: true,
          targetBranch: data.targetBranch,
          concurrency: data.concurrency,
          gitFlow: data.gitFlow,
          reviewAgent: data.reviewAgent,
          ...(data.labelFilter != null ? { labelFilter: data.labelFilter } : {}),
          ...(data.autoMergeLabel != null ? { autoMergeLabel: data.autoMergeLabel } : {})
        })
      })

    return ProjectStore.of({ listProjects, getProject, createProject })
  })
)
