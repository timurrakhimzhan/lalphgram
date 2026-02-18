import { Context, Data, DateTime, Duration, Effect, HashMap, Layer, Option, Ref, Schedule, Stream } from "effect"
import { TaskCreated, TaskUpdated } from "../Events.js"
import type { AppEvent } from "../Events.js"
import { AppRuntimeConfig } from "../schemas/CredentialSchemas.js"
import { TaskTracker } from "./TaskTracker/TaskTracker.js"

export class TaskEventSourceError extends Data.TaggedError("TaskEventSourceError")<{
  message: string
  cause: unknown
}> {}

export interface TaskEventSourceService {
  readonly stream: Stream.Stream<AppEvent, TaskEventSourceError>
}

export class TaskEventSource extends Context.Tag("TaskEventSource")<
  TaskEventSource,
  TaskEventSourceService
>() {}

export const TaskEventSourceLive = Layer.effect(
  TaskEventSource,
  Effect.gen(function*() {
    const config = yield* AppRuntimeConfig
    const tracker = yield* TaskTracker
    const interval = Duration.seconds(config.pollIntervalSeconds)

    const lastPollRef = yield* Ref.make(DateTime.unsafeNow())
    const knownStatesRef = yield* Ref.make(HashMap.empty<string, string>())

    const pollCycle = Effect.gen(function*() {
      const lastPoll = yield* Ref.get(lastPollRef)
      const since = DateTime.formatIso(lastPoll)
      const knownStates = yield* Ref.get(knownStatesRef)

      yield* Ref.set(lastPollRef, DateTime.unsafeNow())

      const issueEvents = yield* tracker.getRecentEvents(since).pipe(
        Effect.mapError((err) =>
          new TaskEventSourceError({ message: `Failed to get recent events: ${String(err)}`, cause: err })
        )
      )

      const events: Array<AppEvent> = []
      for (const issueEvent of issueEvents) {
        if (issueEvent.action === "created") {
          events.push(new TaskCreated({ issue: issueEvent.issue }))
          yield* Ref.update(knownStatesRef, HashMap.set(issueEvent.issue.id, issueEvent.issue.state))
        } else {
          const previousState = HashMap.get(knownStates, issueEvent.issue.id)
          const stateChanged = Option.isNone(previousState) || previousState.value !== issueEvent.issue.state
          if (stateChanged) {
            events.push(
              new TaskUpdated({
                issue: issueEvent.issue,
                previousState: Option.getOrElse(previousState, () => "Unknown")
              })
            )
          }
          yield* Ref.update(knownStatesRef, HashMap.set(issueEvent.issue.id, issueEvent.issue.state))
        }
      }

      return events
    })

    const emptyBatch: Array<AppEvent> = []

    const safePollCycle = pollCycle.pipe(
      Effect.tapError((err) => Effect.logError(`TaskEventSource poll cycle failed: ${err.message}`)),
      Effect.orElseSucceed(() => emptyBatch)
    )

    const eventStream = Stream.repeatEffectWithSchedule(
      safePollCycle,
      Schedule.spaced(interval)
    ).pipe(
      Stream.flatMap((batch) => Stream.fromIterable(batch))
    )

    return TaskEventSource.of({ stream: eventStream })
  })
)
