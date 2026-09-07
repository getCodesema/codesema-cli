// SSR string-render tests, same harness as QuickReplies.test.ts / TaskConversation.test.ts.
// Clicks (open emitted) are not observable here: renderToString never fires a
// real DOM event, so only the markup a given `states` prop renders is
// checked. `needsHuman` is a pure predicate, unit-tested directly instead
// (no SSR needed for it).
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { TaskEvent, TaskRecord, TaskStatus } from '../../types'

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

function record(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'task',
    status: 'queued',
    base: 'main',
    branch: 'codesema/task-x',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-30T08:00:00.000Z',
    updated_at: '2026-08-30T08:00:00.000Z',
    ...partial,
  }
}

function state(partial: Partial<TaskRecord> = {}, events: TaskEvent[] = []): TaskState {
  return {
    projectId: 'p1',
    record: record(partial),
    events,
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
}

async function render(states: TaskState[]): Promise<string> {
  const MobileList = (await import('./MobileList.vue')).default
  const app = createSSRApp(MobileList, { states })
  return renderToString(app)
}

describe('needsHuman: waiting_for_you, review_ko and failed, nothing else', () => {
  test('every status is classified, matching queueSectionOf attention plus the failed complement', async () => {
    const { needsHuman } = await import('./MobileList.vue')
    const expected: Record<TaskStatus, boolean> = {
      waiting_for_you: true,
      review_ko: true,
      interrupted: true,
      failed: true,
      running: false,
      reviewing: false,
      queued: false,
      review_ok: false,
      shipped: false,
    }
    for (const [status, want] of Object.entries(expected) as [TaskStatus, boolean][]) {
      expect(needsHuman(status)).toBe(want)
    }
  })
})

describe('MobileList: row order promotes waiting_for_you, review_ko and failed to the top', () => {
  test('a mixed fixture puts every needs-human status ahead of the rest, most recent first within each group', async () => {
    const states = [
      state({
        id: 'shipped-1',
        title: 'Shipped task',
        status: 'shipped',
        updated_at: '2026-08-30T10:00:00.000Z',
      }),
      state({
        id: 'running-1',
        title: 'Running task',
        status: 'running',
        updated_at: '2026-08-30T11:00:00.000Z',
      }),
      state({
        id: 'review-ko-1',
        title: 'Blocked review task',
        status: 'review_ko',
        updated_at: '2026-08-30T08:00:00.000Z',
      }),
      state({
        id: 'waiting-1',
        title: 'Waiting task',
        status: 'waiting_for_you',
        updated_at: '2026-08-30T12:00:00.000Z',
      }),
    ]
    const html = await render(states)
    const positions = ['Waiting task', 'Blocked review task', 'Running task', 'Shipped task'].map(
      (title) => html.indexOf(title),
    )
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1)
    }
    expect(positions).toEqual(positions.toSorted((a, b) => a - b))
  })
})

describe('MobileList: header counter', () => {
  test('the needsYou counter reflects the widened needs-human set, not just waiting_for_you', async () => {
    const html = await render([
      state({ id: 't1', status: 'waiting_for_you' }),
      state({ id: 't2', status: 'review_ko' }),
      state({ id: 't3', status: 'running' }),
    ])
    expect(html).toContain(`2 ${t('pilot.mobile.needsYou')}`)
  })

  test('no needs-human row hides the counter entirely', async () => {
    const html = await render([state({ id: 't1', status: 'running' })])
    expect(html).not.toContain(t('pilot.mobile.needsYou'))
  })
})

describe('MobileList: row content', () => {
  test('each row renders the title', async () => {
    const html = await render([state({ id: 't1', title: 'Fix the login flow', status: 'running' })])
    expect(html).toContain('Fix the login flow')
    expect(html).toContain(t('pilot.mobile.title'))
  })

  test('the last journal event becomes the row preview line', async () => {
    const html = await render([
      state({ id: 't1', title: 'Add rate limiting', status: 'running' }, [
        {
          seq: 1,
          at: '2026-08-30T08:00:00.000Z',
          type: 'commit',
          data: { sha: 'abc', files_changed: 2 },
        },
      ]),
    ])
    expect(html).toContain(t('workspace.evCommit'))
  })

  test('a task with no events yet shows no preview line', async () => {
    const html = await render([state({ id: 't1', title: 'Fresh task', status: 'running' })])
    expect(html).toContain('Fresh task')
    expect(html).not.toContain('mbl-row-last')
  })

  test('an activity phase takes over the preview line, ahead of the last journal event', async () => {
    const html = await render([
      state(
        {
          id: 't1',
          title: 'Ship the button',
          status: 'running',
          activity: { phase: 'checks', since: '2026-08-30T08:00:00.000Z' },
        },
        [
          {
            seq: 1,
            at: '2026-08-30T08:00:00.000Z',
            type: 'commit',
            data: { sha: 'abc', files_changed: 2 },
          },
        ],
      ),
    ])
    expect(html).toContain(t('pilot.activity.checks'))
    expect(html).not.toContain(t('workspace.evCommit'))
  })
})
