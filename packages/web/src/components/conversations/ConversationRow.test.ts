// Same harness as ForgeControlsPanel.test.ts / WorkQueue.test.ts: `vue/compiler-sfc`
// compiles the SFC with its template inlined (Bun's built-in `.vue` loader keeps
// only `<script setup>`, which drops exactly the half under test), then
// `vue/server-renderer` renders to a STRING (no DOM). CSS-only facts (container
// queries, keyframe rules) are pinned by slicing the raw source instead, the
// same escape hatch ForgeControlsPanel.test.ts uses for its own chevron rotation.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { statusPhraseKey } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { TaskChecks, TaskEvent, TaskRecord, TaskStatus } from '../../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'ConversationRow.vue'), 'utf8')

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'fix the retry loop',
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
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
    ...overrides,
  }
}

function taskState(
  recordOverrides: Partial<TaskRecord> = {},
  stateOverrides: Partial<TaskState> = {},
): TaskState {
  return {
    projectId: 'p1',
    record: record(recordOverrides),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
    ...stateOverrides,
  }
}

function checks(overrides: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'deadbeef',
    started_at: '2026-08-13T10:00:00.000Z',
    finished_at: '2026-08-13T10:01:00.000Z',
    status: 'passed',
    checks: [],
    error: null,
    ...overrides,
  }
}

function questionEvent(question: string): TaskEvent {
  return { seq: 1, at: '2026-08-13T10:05:00.000Z', type: 'question', data: { question } }
}

async function render(
  state: TaskState,
  projectName = 'codesema',
  selected = false,
): Promise<string> {
  const ConversationRow = (await import('./ConversationRow.vue')).default
  const app = createSSRApp(ConversationRow, { state, projectName, selected })
  return renderToString(app)
}

describe('the four lines: meta, title, activity, pills', () => {
  test('meta carries the project name and title carries the record title, verbatim', async () => {
    const html = await render(taskState({ title: 'fix the retry loop' }), 'codesema')
    expect(html).toContain('codesema')
    expect(html).toContain('fix the retry loop')
  })

  test('a running conversation shows a pulsing dot and the running phrase', async () => {
    const state = taskState({ status: 'running' })
    const html = await render(state)
    expect(html).toContain('cvr-activity-glyph--pulse')
    expect(html).toContain('cvr-dot')
    expect(html).toContain(t(statusPhraseKey(state.record, false)))
  })

  test('a review_ko conversation shows the shield-alert glyph, static', async () => {
    const state = taskState({ status: 'review_ko' })
    const html = await render(state)
    expect(html).toContain('cvr-activity-glyph--static')
    expect(html).toContain('lucide-shield-alert')
  })

  test('an open question is shown quoted, not the generic waiting phrase', async () => {
    const state = taskState(
      { status: 'waiting_for_you' },
      { events: [questionEvent('use bun or npm?')] },
    )
    const html = await render(state)
    expect(html).toContain(t('conversations.questionExcerpt', { q: 'use bun or npm?' }))
    expect(html).toContain('lucide-message-circle-question')
  })

  test('reviewing spins, running pulses: the two motions are not the same class', async () => {
    const reviewing = await render(taskState({ status: 'reviewing' }))
    const running = await render(taskState({ status: 'running' }))
    expect(reviewing).toContain('cvr-activity-glyph--spin')
    expect(running).toContain('cvr-activity-glyph--pulse')
    expect(reviewing).not.toContain('cvr-activity-glyph--pulse')
    expect(running).not.toContain('cvr-activity-glyph--spin')
  })
})

describe('reference pills: ticket and checks, both optional, independent', () => {
  test('no ticket, no checks state: the pills block does not render at all', async () => {
    const html = await render(taskState({ status: 'running' }))
    expect(html).not.toContain('cvr-pills')
  })

  test('a linked ticket renders its number and the ticket glyph', async () => {
    const state = taskState({
      status: 'running',
      issue: {
        forge: 'gitlab',
        project: 'group/repo',
        iid: 42,
        url: 'https://example.test/-/issues/42',
      },
    })
    const html = await render(state)
    expect(html).toContain('#42')
    expect(html).toContain('lucide-ticket')
  })

  test('shipped never shows a checks pill, even with a failed run recorded', async () => {
    const state = taskState({ status: 'shipped' }, { checks: checks({ status: 'failed' }) })
    const html = await render(state)
    expect(html).not.toContain('cc-pill--red')
    expect(html).not.toContain(t('conversations.checksFailed'))
  })

  test('a failed run: a red pill with the x glyph', async () => {
    const state = taskState({ status: 'running' }, { checks: checks({ status: 'failed' }) })
    const html = await render(state)
    expect(html).toContain('cc-pill--red')
    expect(html).toContain(t('conversations.checksFailed'))
  })

  test('a merge conflict beats a passed run: the conflict pill wins', async () => {
    const state = taskState(
      { status: 'running', reason: { code: 'merge_conflict' } },
      { checks: checks({ status: 'passed' }) },
    )
    const html = await render(state)
    expect(html).toContain(t('conversations.checksConflict'))
    expect(html).not.toContain(t('conversations.checksPassed'))
  })

  test('checks running: an amber dot, never the spinning glyph class', async () => {
    const state = taskState({ status: 'running' }, { checks: checks({ status: 'running' }) })
    const html = await render(state)
    expect(html).toContain('cc-pill--amber')
    expect(html).toContain('cc-dot')
    expect(html).not.toContain('cvr-activity-glyph--spin cc-dot')
  })

  test('a passed run: a green pill with the check glyph', async () => {
    const state = taskState({ status: 'running' }, { checks: checks({ status: 'passed' }) })
    const html = await render(state)
    expect(html).toContain('cc-pill--green')
    expect(html).toContain(t('conversations.checksPassed'))
  })

  test('a ticket and a checks pill can both show at once', async () => {
    const state = taskState(
      {
        status: 'running',
        issue: {
          forge: 'github',
          project: 'org/repo',
          iid: 7,
          url: 'https://example.test/issues/7',
        },
      },
      { checks: checks({ status: 'passed' }) },
    )
    const html = await render(state)
    expect(html).toContain('#7')
    expect(html).toContain(t('conversations.checksPassed'))
  })
})

describe('geometry: CSS-pinned against the UI kit', () => {
  test('the row padding is half a line by one character, no gap of its own', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-root {'), SOURCE.indexOf('.cvr-meta,'))
    expect(rule).toContain('padding: calc(var(--row) / 2) 1ch;')
    expect(rule).not.toContain('border-radius')
    expect(rule).not.toContain('gap:')
  })

  test('the three text lines are truncated, never wrapped', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-meta,'), SOURCE.indexOf('.cvr-meta {'))
    expect(rule).toContain('overflow: hidden;')
    expect(rule).toContain('text-overflow: ellipsis;')
    expect(rule).toContain('white-space: nowrap;')
  })

  test('the three lines take the kit sizes: 12px meta and activity, bold body title', () => {
    // Each boundary search starts AFTER the previous one: the shared
    // `.cvr-meta, .cvr-title, .cvr-activity {` selector group at the top of
    // the file repeats these same class names before the real per-class
    // rules do, so a bare (unthreaded) indexOf would lock onto that group
    // instead of the rule actually under test.
    const metaStart = SOURCE.indexOf('.cvr-meta {')
    const titleStart = SOURCE.indexOf('.cvr-title {', metaStart)
    const activityStart = SOURCE.indexOf('.cvr-activity {', titleStart)
    const activityGlyphStart = SOURCE.indexOf('.cvr-activity-glyph {', activityStart)

    const meta = SOURCE.slice(metaStart, titleStart)
    expect(meta).toContain('font-size: 12px;')
    expect(meta).not.toContain('line-height')

    const title = SOURCE.slice(titleStart, activityStart)
    expect(title).toContain('font-weight: 700;')
    expect(title).not.toContain('font-size')
    expect(title).not.toContain('line-height')

    const activity = SOURCE.slice(activityStart, activityGlyphStart)
    expect(activity).toContain('font-size: 12px;')
    expect(activity).not.toContain('line-height')
  })

  test('every icon in the row is one em, one size for all of them', () => {
    const svg = SOURCE.slice(
      SOURCE.indexOf('.cvr-activity-glyph svg {'),
      SOURCE.indexOf('.cvr-activity-text {'),
    )
    expect(svg).toContain('width: 1em;')
    expect(svg).toContain('height: 1em;')
    const icon = SOURCE.slice(SOURCE.indexOf('.cvr-pill-icon {'), SOURCE.length)
    expect(icon).toContain('width: 1em;')
    expect(icon).toContain('height: 1em;')
  })

  test('the ticket pill is the kit badge: a neutral hairline, one character of gap', () => {
    const pill = SOURCE.slice(SOURCE.indexOf('.cvr-pill {'), SOURCE.indexOf('.cvr-pill-icon {'))
    expect(pill).toContain('border-color: var(--line);')
    expect(pill).toContain('gap: 1ch;')
    expect(pill).not.toContain('border-radius')
    expect(pill).not.toContain('font-weight')
    expect(SOURCE).toContain('class="cvr-pill badge"')
  })

  test('the pills row sits one notch below the activity line', () => {
    const pills = SOURCE.slice(SOURCE.indexOf('.cvr-pills {'), SOURCE.indexOf('.cvr-pill {'))
    expect(pills).toContain('margin-top: 2px;')
  })

  test('no colour is spelled out: only theme tokens, never a plain hex', () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(SOURCE).not.toContain('rgba(')
  })
})

// The state outline. A coloured left rail is reserved for a STATE and
// forbidden as decoration, so only the two sections that ask something of the
// reader read the row's semantic tone. Working and done stay neutral.
//
// Every row carries a border either way, so switching state never shifts the
// geometry by a pixel.
describe('the row outlines its work state', () => {
  const OUTLINE: Record<TaskStatus, string> = {
    waiting_for_you: 'cvr-root--attention',
    review_ko: 'cvr-root--attention',
    interrupted: 'cvr-root--attention',
    running: 'cvr-root--active',
    reviewing: 'cvr-root--active',
    queued: 'cvr-root--active',
    review_ok: 'cvr-root--ready',
    shipped: 'cvr-root--done',
    failed: 'cvr-root--done',
  }

  test('every one of the nine statuses lands on an outline, none falls through', async () => {
    for (const [status, expected] of Object.entries(OUTLINE)) {
      const html = await render(taskState({ status: status as TaskStatus }))
      expect(html).toContain(expected)
    }
  })

  test('only the two sections that ask for an action read the semantic tone', () => {
    /** The body of one outline rule, and nothing else. */
    function ruleBody(selector: string): string {
      const at = SOURCE.indexOf(selector)
      return SOURCE.slice(at, SOURCE.indexOf('}', at))
    }
    expect(ruleBody('.cvr-root--attention')).toContain('--c: var(--tone);')
    expect(ruleBody('.cvr-root--ready')).toContain('--c: var(--tone);')
    // Working and done are neutral: neither may reach for a state colour.
    for (const selector of ['.cvr-root--active', '.cvr-root--done']) {
      const body = ruleBody(selector)
      expect(body).toContain('--line')
      expect(body).not.toContain('--tone')
    }
  })

  test('the tone comes from the one status table, never from an inline style', async () => {
    const html = await render(taskState({ status: 'waiting_for_you' }))
    expect(html).toContain('data-tone="warn"')
    expect(html).not.toContain('style="color:')
    const shipped = await render(taskState({ status: 'shipped' }))
    expect(shipped).toContain('data-tone="ok"')
  })

  test('the border is on every row, so a state change never moves the layout', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.cvr-root {'), SOURCE.indexOf('.cvr-root--attention'))
    expect(root).toContain('border: 1px solid var(--line);')
    expect(root).toContain('border-left-width: 3px;')
    expect(root).toContain('padding: calc(var(--row) / 2) 1ch;')
  })
})
