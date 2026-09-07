import { describe, expect, test } from 'bun:test'
import { compileScript, parse } from 'vue/compiler-sfc'

// A static top-level `import Foo from './Foo.vue'` is hoisted and runs
// before the Bun.plugin registration below, so it would be resolved by
// Bun's own built-in .vue loader (no render function) and PERMANENTLY
// cached under that broken form for the rest of the whole-suite process —
// every other test file's dynamic `await import('./Foo.vue')` of the same
// path then inherits the same broken module, since Bun's module cache is
// keyed by resolved path and shared process-wide. Same convention as
// TaskConversation.test.ts: only dynamic imports, only after this runs.
Bun.plugin({
  name: 'vue-sfc-with-template',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor } = parse(source, { filename: args.path })
      const compiled = compileScript(descriptor, { id: args.path, inlineTemplate: true })
      return { contents: compiled.content, loader: 'ts' }
    })
  },
})

async function taskEventComponents() {
  const TaskEventLine = (await import('./components/task-events/TaskEventLine.vue')).default
  const TaskEventMessage = (await import('./components/task-events/TaskEventMessage.vue')).default
  const { TASK_EVENT_COMPONENTS } = await import('./task-event-registry')
  return { TaskEventLine, TaskEventMessage, TASK_EVENT_COMPONENTS }
}

// TASK_EVENT_COMPONENTS is exhaustive by CONSTRUCTION (a Record<TaskEventType,
// Component>: vue-tsc fails the build the moment a type is missing an entry),
// but nothing previously locked WHICH component a given type actually routes
// to. That gap is preexisting across all fifteen types; this file closes it
// for the one this ticket (T1.6) turned into a written claim — the CHANGELOG
// states 'branch' is "rendered generically by TaskEventLine", not by a
// bespoke component, and that claim now has a test that fails if it stops
// being true.
describe('TASK_EVENT_COMPONENTS', () => {
  test("'branch' (T1.6) routes to the generic neutral line, not a bespoke renderer", async () => {
    const { TaskEventLine, TASK_EVENT_COMPONENTS } = await taskEventComponents()
    expect(TASK_EVENT_COMPONENTS.branch).toBe(TaskEventLine)
  })

  // Same claim, same shape, for the type T1.3 adds. Deleting the entry is a
  // typecheck error (TS2741, the exhaustive Record), but REROUTING it is not:
  // `queue: TaskEventChecks` compiles and leaves every test green, and the
  // "waiting for a slot" journal line then renders as an empty checks card.
  // The CHANGELOG's claim is that 'queue' is a plain neutral line, like
  // 'cost' and 'isolation' — never an error card; this is that claim's test.
  test("'queue' (T1.3) routes to the generic neutral line, not a checks card", async () => {
    const { TaskEventLine, TASK_EVENT_COMPONENTS } = await taskEventComponents()
    expect(TASK_EVENT_COMPONENTS.queue).toBe(TaskEventLine)
  })

  // Same claim for T2.4: the CHANGELOG states 'issue' is rendered by the
  // generic neutral line. Re-routing it to TaskEventMessage — whose text comes
  // from the turn's response and would swallow the line entirely (DP15) — must
  // fail here rather than in a user's journal.
  test("'issue' (T2.4) routes to the generic neutral line, not a bespoke renderer", async () => {
    const { TaskEventLine, TASK_EVENT_COMPONENTS } = await taskEventComponents()
    expect(TASK_EVENT_COMPONENTS.issue).toBe(TaskEventLine)
  })

  test("'prep' routes to the generic neutral line, not a checks card", async () => {
    const { TaskEventLine, TASK_EVENT_COMPONENTS } = await taskEventComponents()
    expect(TASK_EVENT_COMPONENTS.prep).toBe(TaskEventLine)
  })

  test("'criteria' (T2.5) routes to the generic neutral line, not a bespoke renderer", async () => {
    const { TaskEventLine, TASK_EVENT_COMPONENTS } = await taskEventComponents()
    expect(TASK_EVENT_COMPONENTS.criteria).toBe(TaskEventLine)
  })

  // T3.6. Same claim, and the same failure mode to keep out: routing the merge
  // gate through TaskEventMessage would let `fullTextBySeq` overwrite each of
  // D12's four condition lines with the turn's own response (DP15), so a task
  // refused for `checks_unavailable` would show the agent's reply four times
  // and never say what blocked it.
  test("'merge' (T3.6) routes to the generic neutral line, not a message bubble", async () => {
    const { TaskEventLine, TaskEventMessage, TASK_EVENT_COMPONENTS } = await taskEventComponents()
    expect(TASK_EVENT_COMPONENTS.merge).toBe(TaskEventLine)
    expect(TASK_EVENT_COMPONENTS.merge).not.toBe(TaskEventMessage)
  })
})
