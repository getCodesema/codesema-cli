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

async function render(state: TaskState, projectName = 'codesema-tools'): Promise<string> {
  const ConversationRow = (await import('./ConversationRow.vue')).default
  const app = createSSRApp(ConversationRow, { state, projectName })
  return renderToString(app)
}

describe('one agent session is one row: avatar, role name, activity, timestamp', () => {
  test('the row is the avatar, the project role name, the activity snippet, the timestamp', async () => {
    const html = await render(
      taskState({ title: 'fix the retry loop', branch: 'codesema/task-fix-the-retry-loop' }),
      'codesema-tools',
    )
    expect(html).toContain('codesema-tools')
    expect(html).not.toContain('fix the retry loop')
    expect(html).toContain('class="cvr-avatar"')
    expect(html).toContain('class="cvr-title"')
    expect(html).toContain('class="cvr-snippet"')
    expect(html).toContain('class="cvr-age"')
  })

  test('the identity is the project role, never conversationLabel / ticket title', async () => {
    const html = await render(
      taskState({ title: 'a very long free-form title', branch: 'codesema/task-retry-the-push-2' }),
      'bench',
    )
    expect(html).toContain('bench')
    expect(html).not.toContain('retry the push')
    expect(html).not.toContain('a very long free-form title')
  })

  test('never shows the CLI agent command as the row identity', async () => {
    const html = await render(
      taskState({ agent: 'claude -p --dangerously-skip-permissions', title: 'do stuff' }),
      'my-repo',
    )
    expect(html).toContain('my-repo')
    expect(html).not.toContain('claude')
    expect(html).not.toContain('do stuff')
  })

  test('an empty project name falls back to the sober Agent label', async () => {
    const html = await render(taskState({ title: 'manual work' }), '')
    expect(html).toContain(t('workspace.agentLabel'))
    expect(html).not.toContain('manual work')
  })

  test('the role name stays reachable on hover', async () => {
    const html = await render(taskState({ title: 'the whole untruncated title' }), 'codesema-tools')
    expect(html).toContain('title="codesema-tools"')
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

  test('the muted second line is the status phrase, not the ticket title', async () => {
    const html = await render(taskState({ status: 'running', title: 'secret title' }))
    expect(html).toContain('cvr-snippet')
    expect(html).toContain(t('workspace.phaseRunning'))
    expect(html).not.toContain('secret title')
  })
})

describe('shape: circular avatar, two lines, no card chrome', () => {
  test('the root has no card border or background of its own', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-root {'), SOURCE.indexOf('.cvr-avatar {'))
    expect(rule).not.toContain('border')
    expect(rule).not.toContain('background')
    expect(rule).not.toContain('border-radius')
    expect(rule).not.toContain('box-shadow')
  })

  test('the avatar is a circular tone disc', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-avatar {'), SOURCE.indexOf('.cvr-main {'))
    expect(rule).toContain('border-radius: var(--radius-pill);')
    expect(rule).toContain('background: var(--tone, var(--fg-muted));')
  })

  test('no pill badge, no ticket chip, no lucide icon reaches the template', () => {
    expect(SOURCE).not.toContain('badge')
    expect(SOURCE).not.toContain('cvr-pill')
    expect(SOURCE).not.toContain('lucide')
    expect(SOURCE).not.toContain('@lucide/vue')
    expect(SOURCE).not.toContain('ChecksChip')
    expect(SOURCE).not.toContain('resolveActivityLine')
  })

  test('the layout is avatar + (name/time over snippet)', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-root {'), SOURCE.indexOf('.cvr-avatar {'))
    expect(rule).toContain('grid-template-columns: auto 1fr;')
    expect(SOURCE).toContain('class="cvr-avatar"')
    expect(SOURCE).toContain('class="cvr-snippet"')
  })

  test('the role name is a single line, then ellipsis', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvr-title {'),
      SOURCE.indexOf(".cvr-root[data-finished='true']"),
    )
    expect(rule).toContain('white-space: nowrap;')
    expect(rule).toContain('text-overflow: ellipsis;')
    expect(rule).toContain('overflow: hidden;')
    expect(rule).not.toContain('-webkit-line-clamp')
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

  test('the timestamp is muted, tabular, on the first line', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvr-age {'), SOURCE.indexOf('.cvr-snippet {'))
    expect(rule).toContain('color: var(--fg-muted);')
    expect(rule).toContain('font-size: 12px;')
    expect(rule).toContain('font-variant-numeric: tabular-nums;')
    expect(rule).toContain('white-space: nowrap;')
  })

  test('no colour is spelled out: only theme tokens, never a plain hex', () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(SOURCE).not.toContain('rgba(')
  })
})
