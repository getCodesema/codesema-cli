// SSR string-render tests, same harness as TaskConversation.test.ts. Scroll
// position, the composer's auto-grow/drag math and every click handler
// (back, send, pick, the "other" focus) are DOM-only and not observable via
// renderToString: only the markup a given `state` prop renders is checked.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { TaskEvent, TaskRecord } from '../../types'

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
}

async function render(options: Options = {}): Promise<string> {
  const MobileThread = (await import('./MobileThread.vue')).default
  const app = createSSRApp(MobileThread, {
    state: {
      projectId: 'p1',
      record: record(options.record),
      events: options.events ?? [],
      liveText: '',
      liveMessages: [],
      liveTokens: 0,
      liveLoadCap: null,
      checks: null,
    },
    sending: options.sending ?? false,
  })
  return renderToString(app)
}

const messageEvent: TaskEvent = {
  seq: 1,
  at: '2026-08-30T08:00:00.000Z',
  type: 'message',
  data: { text: 'Here is what changed.' },
}

const questionEvent: TaskEvent = {
  seq: 2,
  at: '2026-08-30T08:05:00.000Z',
  type: 'question',
  data: { question: 'Redis or in-memory?' },
}

describe('MobileThread: header', () => {
  test('the back button and the task title render', async () => {
    const html = await render({ record: { title: 'Fix the login flow' } })
    expect(html).toContain(t('pilot.mobile.back'))
    expect(html).toContain('Fix the login flow')
  })
})

describe('MobileThread: journal events render through the registry', () => {
  test('a message event renders its bubble', async () => {
    const html = await render({ events: [messageEvent] })
    expect(html).toContain('Here is what changed.')
  })

  test('a question event renders its own bubble, regardless of activeness', async () => {
    const html = await render({ record: { status: 'running' }, events: [questionEvent] })
    expect(html).toContain('Redis or in-memory?')
  })
})

describe('MobileThread: evidence and recap bubbles always appear at the end', () => {
  test('both blocks render even with nothing loaded yet', async () => {
    const html = await render({})
    expect(html).toContain(t('pilot.evidence.title'))
    expect(html).toContain(t('pilot.recap.title'))
  })
})

describe('MobileThread: the active question surfaces its own QuestionBlock', () => {
  test('waiting_for_you with a question renders the QuestionBlock banner', async () => {
    const html = await render({ record: { status: 'waiting_for_you' }, events: [questionEvent] })
    expect(html).toContain(t('pilot.question.waiting'))
  })

  test('a non-waiting status renders no QuestionBlock, even with a question event in the journal', async () => {
    const html = await render({ record: { status: 'running' }, events: [questionEvent] })
    expect(html).not.toContain(t('pilot.question.waiting'))
  })

  test('waiting_for_you with no question event renders no QuestionBlock', async () => {
    const html = await render({ record: { status: 'waiting_for_you' }, events: [] })
    expect(html).not.toContain(t('pilot.question.waiting'))
  })
})

describe('MobileThread: the active question never renders twice', () => {
  test('the active question is absent from the event stream, present only in QuestionBlock', async () => {
    const html = await render({ record: { status: 'waiting_for_you' }, events: [questionEvent] })
    expect([...html.matchAll(/Redis or in-memory\?/g)]).toHaveLength(1)
    expect(html).not.toContain('tvq-bubble')
  })

  test('a past-turn question (already answered) stays in the event stream', async () => {
    const pastQuestionEvent: TaskEvent = {
      seq: 1,
      at: '2026-08-30T07:00:00.000Z',
      type: 'question',
      data: { question: 'Which env first?' },
    }
    const activeQuestionEvent: TaskEvent = {
      seq: 2,
      at: '2026-08-30T08:05:00.000Z',
      type: 'question',
      data: { question: 'Redis or in-memory?' },
    }
    const html = await render({
      record: { status: 'waiting_for_you' },
      events: [pastQuestionEvent, activeQuestionEvent],
    })
    expect(html).toContain('tvq-bubble')
    expect([...html.matchAll(/Which env first\?/g)]).toHaveLength(1)
    expect([...html.matchAll(/Redis or in-memory\?/g)]).toHaveLength(1)
  })
})

describe('MobileThread: composer', () => {
  test('the reply composer renders, disabled while sending', async () => {
    const html = await render({ sending: true })
    expect(html).toContain('class="cc-root"')
    expect(html).toContain(t('workspace.replyPlaceholder'))
    expect(html).toContain('disabled')
  })
})
