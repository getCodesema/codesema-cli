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
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { t } from '../../i18n'
import type { TaskRecord, TaskStatus } from '../../types'

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

function taskState(recordOverrides: Partial<TaskRecord> = {}): TaskState {
  return {
    projectId: 'p1',
    record: record(recordOverrides),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
}

async function render(state: TaskState): Promise<string> {
  const ConversationRow = (await import('./ConversationRow.vue')).default
  const app = createSSRApp(ConversationRow, { state })
  return renderToString(app)
}

describe('one conversation is one line: glyph, title, age', () => {
  test('the line is the title, the status glyph, and nothing else from the record', async () => {
    const html = await render(taskState({ title: 'fix the retry loop' }))
    expect(html).toContain('fix the retry loop')
    expect(html).toContain('class="cvr-title"')
    expect(html).toContain('class="cvr-age"')
  })

  test('the glyph comes from the one status table, never from a local mapping', async () => {
    for (const status of Object.keys(EXECUTION_STATUS) as TaskStatus[]) {
      const html = await render(taskState({ status }))
      expect(html).toContain(EXECUTION_STATUS[status].icon)
    }
  })

  test('the glyph is labelled, so it is never the only carrier of the state', async () => {
    const html = await render(taskState({ status: 'waiting_for_you' }))
    expect(html).toContain('role="img"')
    expect(html).toContain(t(EXECUTION_STATUS.waiting_for_you.labelKey))
  })

  test('a running conversation blinks, a waiting one does not', async () => {
    const running = await render(taskState({ status: 'running' }))
    const waiting = await render(taskState({ status: 'waiting_for_you' }))
    expect(running).toContain('cvr-glyph--pulse')
    expect(waiting).not.toContain('cvr-glyph--pulse')
  })

  test('the tone comes from the one status table, never from an inline style', async () => {
    const html = await render(taskState({ status: 'waiting_for_you' }))
    expect(html).toContain('data-tone="warn"')
    expect(html).not.toContain('style="color:')
    const shipped = await render(taskState({ status: 'shipped' }))
    expect(shipped).toContain('data-tone="ok"')
  })

  test('a finished conversation is flagged so its title dims', async () => {
    const shipped = await render(taskState({ status: 'shipped' }))
    const running = await render(taskState({ status: 'running' }))
    expect(shipped).toContain('data-finished="true"')
    expect(running).toContain('data-finished="false"')
  })
})

describe('nothing else is drawn: no card, no pill, no meta line', () => {
  test('the row has no card, no border, no background of its own', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-root {'), SOURCE.indexOf('.cvr-glyph {'))
    expect(rule).not.toContain('border')
    expect(rule).not.toContain('background')
    expect(rule).not.toContain('border-radius')
    expect(rule).not.toContain('box-shadow')
  })

  test('no pill, no badge, no ticket chip, no lucide icon reaches the template', () => {
    expect(SOURCE).not.toContain('badge')
    expect(SOURCE).not.toContain('cvr-pill')
    expect(SOURCE).not.toContain('lucide')
    expect(SOURCE).not.toContain('@lucide/vue')
    expect(SOURCE).not.toContain('ChecksChip')
    expect(SOURCE).not.toContain('resolveActivityLine')
  })

  test('the line is the kit grid: one glyph column, the title, the age', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-root {'), SOURCE.indexOf('.cvr-glyph {'))
    expect(rule).toContain('grid-template-columns: 1ch 1fr auto;')
    expect(rule).toContain('gap: 1ch;')
    expect(rule).toContain('align-items: baseline;')
  })

  test('the title truncates, never wraps', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvr-title {'),
      SOURCE.indexOf(".cvr-root[data-finished='true']"),
    )
    expect(rule).toContain('overflow: hidden;')
    expect(rule).toContain('text-overflow: ellipsis;')
    expect(rule).toContain('white-space: nowrap;')
    expect(rule).toContain('color: var(--fg);')
  })

  test('a finished title dims to --fg-dim rather than fading with opacity', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf(".cvr-root[data-finished='true']"),
      SOURCE.indexOf('.cvr-age {'),
    )
    expect(rule).toContain('color: var(--fg-dim);')
    expect(SOURCE).not.toContain('opacity')
  })

  test('the age is muted, on its own tabular column', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-age {'), SOURCE.length)
    expect(rule).toContain('color: var(--fg-muted);')
    expect(rule).toContain('font-variant-numeric: tabular-nums;')
  })

  test('the running blink never keeps a fill mode', () => {
    expect(SOURCE).toContain('animation: blink 1.2s steps(2) infinite;')
    expect(SOURCE).not.toMatch(/animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/)
  })

  test('no colour is spelled out: only theme tokens, never a plain hex', () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(SOURCE).not.toContain('rgba(')
  })
})
