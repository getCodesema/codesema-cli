// SSR string-render tests, same harness as QuickReplies.test.ts. Click
// handlers (`emit('open-full')`, `emit('open-lens', …)`, `emit('send', …)`,
// `emit('pick', …)`) are not observable here since `renderToString` never
// triggers a DOM event: this file only checks the markup a given state
// renders.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { TaskRecord } from '../../types'

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

type Props = { state: TaskState; sending?: boolean }

async function render(props: Props): Promise<string> {
  const AgentCard = (await import('./AgentCard.vue')).default
  const app = createSSRApp(AgentCard, props)
  return renderToString(app)
}

function record(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'Add the retry button',
    status: 'running',
    base: 'main',
    branch: 'codesema/task-x',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-14T10:00:00.000Z',
    updated_at: '2026-08-14T10:00:00.000Z',
    ...partial,
  }
}

function state(partial: Partial<TaskState> = {}): TaskState {
  return {
    projectId: 'proj-9',
    record: record(),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
    ...partial,
  }
}

describe('AgentCard: header carries status, title, project and branch', () => {
  test('the title renders', async () => {
    const html = await render({
      state: state({ record: record({ title: 'Add the retry button' }) }),
    })
    expect(html).toContain('Add the retry button')
  })

  test('the project id and branch render in the mono sub line', async () => {
    const html = await render({
      state: state({ projectId: 'proj-9', record: record({ branch: 'codesema/task-x' }) }),
    })
    expect(html).toContain('proj-9')
    expect(html).toContain('codesema/task-x')
  })

  test('a branch-less task falls back to base', async () => {
    const html = await render({
      state: state({ record: record({ branch: '', base: 'main' }) }),
    })
    expect(html).toContain('main')
  })

  test('the root carries a status class per state', async () => {
    const html = await render({ state: state({ record: record({ status: 'running' }) }) })
    expect(html).toContain('ac-root--running')
  })

  test('the status phrase renders through EXECUTION_STATUS', async () => {
    const html = await render({ state: state({ record: record({ status: 'running' }) }) })
    expect(html).toContain(t('workspace.phaseRunning'))
  })

  test('a header click target is a real, accessible button', async () => {
    const html = await render({ state: state() })
    expect(html).toContain('<button type="button" class="ac-head"')
  })
})

describe('AgentCard: the four block zones are always present', () => {
  test('evidence, recap, checks and criteria all render their block title', async () => {
    const html = await render({ state: state() })
    expect(html).toContain(t('pilot.evidence.title'))
    expect(html).toContain(t('pilot.recap.title'))
    expect(html).toContain(t('pilot.checks.title'))
    expect(html).toContain(t('pilot.criteria.title'))
  })

  test('each block sits in its own clickable zone', async () => {
    const html = await render({ state: state() })
    expect(html.match(/class="ac-zone"/g)?.length).toBe(4)
  })

  test("absent recap/checks/evidence/criteria show each block's own honest empty state", async () => {
    const html = await render({ state: state() })
    expect(html).toContain(t('pilot.evidence.none'))
    expect(html).toContain(t('pilot.recap.pending'))
    expect(html).toContain(t('workspace.checksNeverRan'))
    expect(html).toContain(t('pilot.criteria.none'))
  })

  test('criteria comes from the recap, not the task record', async () => {
    const html = await render({
      state: state({
        recap: {
          version: 1,
          summary: 'done',
          changes: [],
          decisions: [],
          files: [],
          tests: [],
          branch: 'codesema/task-x',
          criteria: [{ criterion_id: 'ac-000000000001', status: 'met', text: 'ships the button' }],
        },
      }),
    })
    expect(html).toContain('ships the button')
    expect(html).not.toContain(t('pilot.criteria.none'))
  })
})

describe('AgentCard: the question banner only shows while waiting for a human answer', () => {
  test('waiting_for_you with a question event renders QuestionBlock', async () => {
    const html = await render({
      state: state({
        record: record({ status: 'waiting_for_you' }),
        events: [
          {
            seq: 1,
            at: '2026-08-14T10:00:00.000Z',
            type: 'question',
            data: { text: 'main or develop?' },
          },
        ],
      }),
    })
    expect(html).toContain(t('pilot.question.waiting'))
    expect(html).toContain('main or develop?')
  })

  test('running with no active question renders no banner at all', async () => {
    const html = await render({
      state: state({
        record: record({ status: 'running' }),
        events: [
          {
            seq: 1,
            at: '2026-08-14T10:00:00.000Z',
            type: 'question',
            data: { text: 'stale question' },
          },
        ],
      }),
    })
    expect(html).not.toContain(t('pilot.question.waiting'))
    expect(html).not.toContain('stale question')
  })

  test('waiting_for_you with no question event at all renders no banner', async () => {
    const html = await render({ state: state({ record: record({ status: 'waiting_for_you' }) }) })
    expect(html).not.toContain(t('pilot.question.waiting'))
  })

  test('an enumerated question also renders its quick-reply buttons', async () => {
    const html = await render({
      state: state({
        record: record({ status: 'waiting_for_you' }),
        events: [
          {
            seq: 1,
            at: '2026-08-14T10:00:00.000Z',
            type: 'question',
            data: { text: 'main ou develop ?' },
          },
        ],
      }),
    })
    expect(html).toContain('→ main')
    expect(html).toContain('→ develop')
  })
})

describe("AgentCard: the action row mirrors TaskConversation's header conditions, minus Cleanup", () => {
  test('review_ok shows Ship, and only Ship', async () => {
    const html = await render({ state: state({ record: record({ status: 'review_ok' }) }) })
    expect(html).toContain('ac-action--ship')
    expect(html).toContain(t('workspace.ship'))
    expect(html).not.toContain('ac-action--stop')
    expect(html).not.toContain('ac-action--resume')
  })

  test('running shows Stop, and only Stop', async () => {
    const html = await render({ state: state({ record: record({ status: 'running' }) }) })
    expect(html).toContain('ac-action--stop')
    expect(html).toContain(t('workspace.interrupt'))
    expect(html).not.toContain('ac-action--ship')
    expect(html).not.toContain('ac-action--resume')
  })

  test('queued and waiting_for_you also show Stop', async () => {
    for (const status of ['queued', 'waiting_for_you'] as const) {
      const html = await render({ state: state({ record: record({ status }) }) })
      expect(html).toContain('ac-action--stop')
    }
  })

  // A turn frees its slot to the reviewer before handing over: an interrupt
  // during 'reviewing' always 409s on the server, so the button that could
  // not stop anything is never offered (same reasoning as TaskConversation's
  // own canInterrupt).
  test('reviewing shows no Stop button, and no action row at all', async () => {
    const html = await render({ state: state({ record: record({ status: 'reviewing' }) }) })
    expect(html).not.toContain('ac-action--stop')
    expect(html).not.toContain('ac-actions')
  })

  test('an interrupted task with a restartable turn shows Resume', async () => {
    const html = await render({
      state: state({
        record: record({
          status: 'interrupted',
          turns: [
            {
              prompt: 'do it',
              response: null,
              question: null,
              started_at: '2026-08-14T10:00:00.000Z',
              ended_at: null,
            },
          ],
        }),
      }),
    })
    expect(html).toContain('ac-action--resume')
    expect(html).toContain(t('workspace.resume'))
  })

  test('an interrupted task whose last turn already answered shows no Resume', async () => {
    const html = await render({
      state: state({
        record: record({
          status: 'interrupted',
          turns: [
            {
              prompt: 'do it',
              response: 'done',
              question: null,
              started_at: '2026-08-14T10:00:00.000Z',
              ended_at: '2026-08-14T10:00:05.000Z',
            },
          ],
        }),
      }),
    })
    expect(html).not.toContain('ac-action--resume')
  })

  test('a shipped task shows no action row at all', async () => {
    const html = await render({ state: state({ record: record({ status: 'shipped' }) }) })
    expect(html).not.toContain('ac-actions')
  })

  test('the action buttons disable while sending', async () => {
    const html = await render({
      state: state({ record: record({ status: 'review_ok' }) }),
      sending: true,
    })
    const match = html.match(/<button[^>]*class="ac-action ac-action--ship"[^>]*>/)
    expect(match).not.toBeNull()
    expect(match?.[0]).toContain('disabled')
  })
})

describe('AgentCard: the composer always renders', () => {
  test('the reply placeholder is the shared existing string, no new key', async () => {
    const html = await render({ state: state() })
    expect(html).toContain(t('workspace.replyPlaceholder'))
  })

  // The composer's own draft starts empty (AgentCard owns no way to seed it
  // from a prop), so an empty draft alone already disables send: this only
  // proves the `sending` prop reaches ChatComposer without breaking the
  // render, not that it independently causes the disabled state.
  test('the sending prop threads through to ChatComposer without breaking the render', async () => {
    const html = await render({ state: state(), sending: true })
    const match = html.match(/<button[^>]*class="cc-send"[^>]*>/)
    expect(match).not.toBeNull()
    expect(match?.[0]).toContain('disabled')
  })
})

describe('AgentCard: no hex color literal in its scoped style', () => {
  test('every color comes from a --cs- token', () => {
    const source = readFileSync(fileURLToPath(new URL('./AgentCard.vue', import.meta.url)), 'utf-8')
    const style = source.slice(source.indexOf('<style'))
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
