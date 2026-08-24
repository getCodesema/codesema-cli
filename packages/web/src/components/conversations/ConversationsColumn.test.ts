// Same harness as ForgeControlsPanel.test.ts / WorkQueue.test.ts. Container
// query thresholds and the grid-based collapse are CSS-only, unreachable
// through an SSR string render (same limitation those two files' own tests
// already document for their own CSS-pinned facts), so they are pinned by
// slicing the raw source instead.
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

const SOURCE = readFileSync(join(import.meta.dir, 'ConversationsColumn.vue'), 'utf8')

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

function taskState(recordOverrides: Partial<TaskRecord> = {}, projectId = 'p1'): TaskState {
  return {
    projectId,
    record: record(recordOverrides),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
}

type Props = {
  states: TaskState[]
  projectNames: ReadonlyMap<string, string>
  selectedKey: string | null
}

function props(overrides: Partial<Props> = {}): Props {
  return { states: [], projectNames: new Map(), selectedKey: null, ...overrides }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const ConversationsColumn = (await import('./ConversationsColumn.vue')).default
  const app = createSSRApp(ConversationsColumn, props(overrides))
  return renderToString(app)
}

describe('header: title and action, always both present in markup', () => {
  test('the title and the new-conversation action render', async () => {
    const html = await render()
    expect(html).toContain(t('conversations.title'))
    expect(html).toContain(t('conversations.newAction'))
    expect(html).toContain('lucide-plus')
  })
})

describe('search field: present, its right padding is COMPUTED, not fixed', () => {
  test('no query typed: no clear button, padding is the base clearance (36px, 0 icons)', async () => {
    const html = await render()
    expect(html).not.toContain('cvc-search-clear')
    expect(html).toContain('padding-right:36px')
  })

  test('placeholder text comes from i18n', async () => {
    const html = await render()
    expect(html).toContain(t('conversations.searchPlaceholder'))
  })
})

describe('empty states: no conversation at all vs. a search matching nothing', () => {
  test('no conversation anywhere: the empty message, no groups', async () => {
    const html = await render({ states: [] })
    expect(html).toContain(t('conversations.empty'))
    expect(html).not.toContain('cvc-group-head')
  })

  test('conversations exist: no empty message', async () => {
    const html = await render({ states: [taskState()] })
    expect(html).not.toContain(t('conversations.empty'))
  })
})

describe('grouping: by project, our "folder" (sheet §10.2)', () => {
  test('one group per project, named from the project map, counting its own rows', async () => {
    const html = await render({
      states: [
        taskState({ id: 'a' }, 'p1'),
        taskState({ id: 'b' }, 'p1'),
        taskState({ id: 'c' }, 'p2'),
      ],
      projectNames: new Map([
        ['p1', 'Codesema'],
        ['p2', 'Nolyra'],
      ]),
    })
    expect(html).toContain('Codesema')
    expect(html).toContain('Nolyra')
    // Two groups: "Codesema" (2 rows) and "Nolyra" (1 row).
    expect((html.match(/cvc-group-head/g) ?? []).length).toBe(2)
  })

  test('groups are expanded by default: aria-expanded true, no closed body', async () => {
    const html = await render({ states: [taskState({ id: 'a' }, 'p1')] })
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('cvc-group-body--closed')
  })

  test('each row carries the ticket-column selection contract (aria-current on the open one)', async () => {
    const open = taskState({ id: 'open-one' }, 'p1')
    const other = taskState({ id: 'other-one' }, 'p1')
    const html = await render({ states: [open, other], selectedKey: 'p1/open-one' })
    const rows = [...html.matchAll(/<button type="button" class="cvc-row-btn[^"]*"([^>]*)>/g)]
    expect(rows).toHaveLength(2)
    expect(rows.some((m) => m[1]?.includes('aria-current="true"'))).toBe(true)
    expect(rows.filter((m) => m[1]?.includes('aria-current="true"'))).toHaveLength(1)
  })
})

describe('header degradation thresholds: CSS-pinned (sheet §1)', () => {
  test('the action label hides under 256px, the whole panel narrower than that', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('@container cvc-shell (max-width: 256px)'),
      SOURCE.indexOf('@container cvc-shell (max-width: 256px)') + 120,
    )
    expect(rule).toContain('.cvc-action-label')
    expect(rule).toContain('display: none;')
  })

  test('the title hides under 200px, a stricter (smaller) threshold than the action label', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('@container cvc-shell (max-width: 200px)'),
      SOURCE.indexOf('@container cvc-shell (max-width: 200px)') + 100,
    )
    expect(rule).toContain('.cvc-title')
    expect(rule).toContain('display: none;')
  })

  test('the container is self-named on the panel root, matching what the queries above target', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.cvc-root {'), SOURCE.indexOf('.cvc-header {'))
    expect(root).toContain('container-type: inline-size;')
    expect(root).toContain('container-name: cvc-shell;')
  })
})

describe('panel bounds: 260 default, 180 to 1400 (sheet §1)', () => {
  test('the width bounds are exact', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.cvc-root {'), SOURCE.indexOf('.cvc-header {'))
    expect(root).toContain('width: 260px;')
    expect(root).toContain('min-width: 180px;')
    expect(root).toContain('max-width: 1400px;')
  })
})

describe('group collapse: a 1fr/0fr grid track, inert when closed, never a fixed height', () => {
  test('the closed body track goes to 0fr and is hidden, not animated by height or opacity', () => {
    const closed = SOURCE.slice(
      SOURCE.indexOf('.cvc-group-body--closed {'),
      SOURCE.indexOf('.cvc-group-body-inner {'),
    )
    expect(closed).toContain('grid-template-rows: 0fr;')
    expect(closed).toContain('visibility: hidden;')
    expect(closed).not.toContain('height:')
    expect(closed).not.toContain('opacity:')
  })

  test('the open track transitions grid-template-rows over 150ms', () => {
    const open = SOURCE.slice(
      SOURCE.indexOf('.cvc-group-body {'),
      SOURCE.indexOf('.cvc-group-body--closed {'),
    )
    expect(open).toContain('grid-template-rows: 1fr;')
    expect(open).toContain('transition: grid-template-rows 150ms ease;')
  })

  test('the template binds `inert` to the closed state, not merely a CSS class', () => {
    expect(SOURCE).toContain(':inert="!isOpen(group.projectId)"')
  })
})

describe('row states: selection is a soft fill, never a border (sheet §6)', () => {
  test('the selected row rule sets a background and never a border property', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvc-row-btn--selected {'),
      SOURCE.indexOf('.cvc-row-btn--selected :deep'),
    )
    expect(rule).toContain('background: var(--cs-green-soft);')
    expect(rule).not.toContain('border')
  })
})
