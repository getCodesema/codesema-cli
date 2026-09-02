// SSR string-render tests, same harness as AgentCard.test.ts. Scroll
// following, the composer's auto-grow and every click handler (back, send,
// pick, ship, stop, resume, the "other" focus) are DOM-only and not
// observable via renderToString: only the markup a given `state` renders is
// checked.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { EvidenceRecord, RecapRecord, TaskEvent, TaskRecord } from '../../types'

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

type Options = {
  record?: Partial<TaskRecord>
  events?: TaskEvent[]
  sending?: boolean
  showBack?: boolean
  recap?: RecapRecord | null
  evidence?: EvidenceRecord | null
  liveMessages?: { seq: number; text: string }[]
}

async function render(options: Options = {}): Promise<string> {
  const PilotThread = (await import('./PilotThread.vue')).default
  const app = createSSRApp(PilotThread, {
    state: {
      projectId: 'p1',
      record: record(options.record),
      events: options.events ?? [],
      liveText: '',
      liveMessages: options.liveMessages ?? [],
      liveTokens: 0,
      liveLoadCap: null,
      checks: null,
      recap: options.recap,
      evidence: options.evidence,
    },
    sending: options.sending ?? false,
    showBack: options.showBack ?? false,
  })
  return renderToString(app)
}

function event(seq: number, type: TaskEvent['type'], data: TaskEvent['data'] = {}): TaskEvent {
  return { seq, at: `2026-08-30T08:${String(seq).padStart(2, '0')}:00.000Z`, type, data }
}

const messageEvent = event(1, 'message', { text: 'Here is what changed.' })
const questionEvent = event(2, 'question', { question: 'Redis or in-memory?' })

function blockOrder(html: string): string[] {
  const found = [...html.matchAll(/pt-block pt-block--(criteria|checks|evidence|recap)/g)]
  return found.map((match) => match[1] ?? '')
}

describe('PilotThread: header', () => {
  test('the task title, project and branch render; no back button by default', async () => {
    const html = await render({ record: { title: 'Fix the login flow' } })
    expect(html).toContain('Fix the login flow')
    expect(html).toContain('p1')
    expect(html).toContain('codesema/task-x')
    expect(html).not.toContain('pt-back')
  })

  test('showBack renders the back button', async () => {
    const html = await render({ showBack: true })
    expect(html).toContain('pt-back')
    expect(html).toContain(t('pilot.mobile.back'))
  })

  test('an activity phase renders its phrase in the header', async () => {
    const html = await render({
      record: { activity: { phase: 'proof', since: '2026-08-30T08:00:00.000Z' } },
    })
    expect(html).toContain(t('pilot.activity.proof'))
  })
})

describe('PilotThread: actions follow the status, same offers as AgentCard', () => {
  test('review_ok offers Ship only', async () => {
    const html = await render({ record: { status: 'review_ok' } })
    expect(html).toContain('pt-action--ship')
    expect(html).not.toContain('pt-action--stop')
  })

  test('running offers Stop only', async () => {
    const html = await render({ record: { status: 'running' } })
    expect(html).toContain('pt-action--stop')
    expect(html).not.toContain('pt-action--ship')
  })

  test('shipped offers nothing', async () => {
    const html = await render({ record: { status: 'shipped' } })
    expect(html).not.toContain('pt-actions')
  })

  test('sending disables the offered action', async () => {
    const html = await render({ record: { status: 'review_ok' }, sending: true })
    expect(html).toMatch(/pt-action--ship[^>]*disabled/)
  })
})

describe('PilotThread: the four blocks always render, anchored in the chat', () => {
  test('with an empty journal, the four blocks trail in fixed order', async () => {
    const html = await render({})
    expect(blockOrder(html)).toEqual(['criteria', 'checks', 'evidence', 'recap'])
    expect(html).toContain(t('pilot.criteria.title'))
    expect(html).toContain(t('pilot.checks.title'))
    expect(html).toContain(t('pilot.evidence.title'))
    expect(html).toContain(t('pilot.recap.title'))
  })

  test('criteria follow the first prompt, checks and evidence the run, the recap the reply', async () => {
    const html = await render({
      record: { turns: [{ prompt: 'Add a services section' } as never] },
      events: [
        event(1, 'turn_started'),
        event(2, 'tool_use', { name: 'Edit' }),
        event(3, 'message', { text: 'Done.' }),
        event(4, 'commit', { sha: 'abc1234' }),
        event(5, 'checks', { status: 'passed' }),
        event(6, 'review_started'),
      ],
    })
    const order = [
      html.indexOf('Add a services section'),
      html.indexOf('pt-block--criteria'),
      html.indexOf('Done.'),
      html.indexOf('pt-block--recap'),
      html.indexOf('pt-block--checks'),
      html.indexOf('pt-block--evidence'),
    ]
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].toSorted((a, b) => a - b))
    expect(blockOrder(html)).toEqual(['criteria', 'recap', 'checks', 'evidence'])
  })

  test('a recap renders its criteria inside the criteria block', async () => {
    const html = await render({
      recap: {
        version: 1,
        summary: 'Section added.',
        changes: [],
        decisions: [],
        files: [],
        tests: [],
        criteria: [{ criterion_id: 'c1', status: 'met', text: 'Three cards show' }],
        branch: 'codesema/task-x',
      } satisfies RecapRecord,
    })
    expect(html).toContain('Three cards show')
    expect(html).toContain('Section added.')
  })
})

describe('PilotThread: journal events render through the registry', () => {
  test('a message event renders its bubble', async () => {
    const html = await render({ events: [messageEvent] })
    expect(html).toContain('Here is what changed.')
  })

  test('the user prompt of each turn renders as a user bubble before its turn line', async () => {
    const html = await render({
      record: { turns: [{ prompt: 'Rename the helper' } as never] },
      events: [event(1, 'turn_started'), messageEvent],
    })
    expect(html).toContain('tvu-bubble')
    expect(html.indexOf('Rename the helper')).toBeLessThan(html.indexOf('Here is what changed.'))
  })

  test('consecutive tool events fold into one closed details block', async () => {
    const html = await render({
      record: { status: 'review_ok', turns: [{ prompt: 'x', ended_at: null } as never] },
      events: [
        event(1, 'turn_started'),
        event(2, 'tool_use', { name: 'Read' }),
        event(3, 'tool_result', {}),
        event(4, 'tool_use', { name: 'Edit' }),
        event(5, 'message', { text: 'ok' }),
      ],
    })
    expect(html.match(/<details/g)).toHaveLength(1)
    expect(html).toContain(t('workspace.toolsDetail'))
    expect(html).toContain(t('workspace.toolsCount', { n: 2 }))
    expect(html).not.toContain('pt-tools--live')
  })

  test('the open turn of a running task renders its tools as a live block', async () => {
    const html = await render({
      record: {
        status: 'running',
        turns: [{ prompt: 'x', started_at: '2026-08-30T08:00:00.000Z', ended_at: null } as never],
      },
      events: [event(1, 'turn_started'), event(2, 'tool_use', { name: 'Read' })],
    })
    expect(html).toContain('pt-tools--live')
    expect(html).toContain(t('workspace.agentWorking'))
  })

  test('live messages render as bubbles while running, never otherwise', async () => {
    const running = await render({
      record: { status: 'running' },
      liveMessages: [{ seq: 1, text: 'streaming now' }],
    })
    expect(running).toContain('streaming now')
    expect(running).toContain(t('workspace.agentWriting'))
    const idle = await render({
      record: { status: 'review_ok' },
      liveMessages: [{ seq: 1, text: 'streaming now' }],
    })
    expect(idle).not.toContain('streaming now')
  })

  test('reviewing shows the review frame even before any progress line', async () => {
    const html = await render({ record: { status: 'reviewing' } })
    expect(html).toContain('pt-live--review')
    expect(html).toContain(t('workspace.evReviewStarted'))
  })
})

describe('PilotThread: the active question surfaces its own QuestionBlock, once', () => {
  test('waiting_for_you with a question renders the QuestionBlock banner', async () => {
    const html = await render({ record: { status: 'waiting_for_you' }, events: [questionEvent] })
    expect(html).toContain(t('pilot.question.waiting'))
    expect([...html.matchAll(/Redis or in-memory\?/g)]).toHaveLength(1)
    expect(html).not.toContain('tvq-bubble')
  })

  test('a non-waiting status renders no QuestionBlock, the question stays in the stream', async () => {
    const html = await render({ record: { status: 'running' }, events: [questionEvent] })
    expect(html).not.toContain(t('pilot.question.waiting'))
    expect(html).toContain('Redis or in-memory?')
  })

  test('a past-turn question stays in the stream next to the active one', async () => {
    const html = await render({
      record: { status: 'waiting_for_you' },
      events: [event(1, 'question', { question: 'Which env first?' }), questionEvent],
    })
    expect(html).toContain('tvq-bubble')
    expect([...html.matchAll(/Which env first\?/g)]).toHaveLength(1)
    expect([...html.matchAll(/Redis or in-memory\?/g)]).toHaveLength(1)
  })
})

describe('PilotThread: composer', () => {
  test('the reply composer renders, disabled while sending', async () => {
    const html = await render({ sending: true })
    expect(html).toContain('class="cc-root"')
    expect(html).toContain(t('workspace.replyPlaceholder'))
    expect(html).toContain('disabled')
  })
})
