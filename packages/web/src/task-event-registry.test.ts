import { describe, expect, test } from 'bun:test'
import TaskEventLine from './components/task-events/TaskEventLine.vue'
import { TASK_EVENT_COMPONENTS } from './task-event-registry'

// TASK_EVENT_COMPONENTS is exhaustive by CONSTRUCTION (a Record<TaskEventType,
// Component>: vue-tsc fails the build the moment a type is missing an entry),
// but nothing previously locked WHICH component a given type actually routes
// to. That gap is preexisting across all fifteen types; this file closes it
// for the one this ticket (T1.6) turned into a written claim — the CHANGELOG
// states 'branch' is "rendered generically by TaskEventLine", not by a
// bespoke component, and that claim now has a test that fails if it stops
// being true.
describe('TASK_EVENT_COMPONENTS', () => {
  test("'branch' (T1.6) routes to the generic neutral line, not a bespoke renderer", () => {
    expect(TASK_EVENT_COMPONENTS.branch).toBe(TaskEventLine)
  })

  // Same claim, same shape, for the type T1.3 adds. Deleting the entry is a
  // typecheck error (TS2741, the exhaustive Record), but REROUTING it is not:
  // `queue: TaskEventChecks` compiles and leaves every test green, and the
  // "waiting for a slot" journal line then renders as an empty checks card.
  // The CHANGELOG's claim is that 'queue' is a plain neutral line, like
  // 'cost' and 'isolation' — never an error card; this is that claim's test.
  test("'queue' (T1.3) routes to the generic neutral line, not a checks card", () => {
    expect(TASK_EVENT_COMPONENTS.queue).toBe(TaskEventLine)
  })

  // Same claim for T2.4: the CHANGELOG states 'issue' is rendered by the
  // generic neutral line. Re-routing it to TaskEventMessage — whose text comes
  // from the turn's response and would swallow the line entirely (DP15) — must
  // fail here rather than in a user's journal.
  test("'issue' (T2.4) routes to the generic neutral line, not a bespoke renderer", () => {
    expect(TASK_EVENT_COMPONENTS.issue).toBe(TaskEventLine)
  })

  test("'prep' routes to the generic neutral line, not a checks card", () => {
    expect(TASK_EVENT_COMPONENTS.prep).toBe(TaskEventLine)
  })
})
