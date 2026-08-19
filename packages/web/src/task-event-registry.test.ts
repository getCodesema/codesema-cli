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
})
