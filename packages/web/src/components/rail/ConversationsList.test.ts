// Same harness as ConversationsColumn.test.ts, this component's own source.
// Container query thresholds and the grid-based collapse are CSS-only,
// unreachable through an SSR string render, so those are pinned by slicing
// the raw source instead.
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

const SOURCE = readFileSync(join(import.meta.dir, 'ConversationsList.vue'), 'utf8')

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
  focusedKeys: readonly string[]
}

function props(overrides: Partial<Props> = {}): Props {
  return { states: [], projectNames: new Map(), focusedKeys: [], ...overrides }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const ConversationsList = (await import('./ConversationsList.vue')).default
  const app = createSSRApp(ConversationsList, props(overrides))
  return renderToString(app)
}

describe('header: title, counter, and a primary create action', () => {
  test('the title and the new-conversation action render', async () => {
    const html = await render()
    expect(html).toContain(t('conversations.title'))
    expect(html).toContain(t('conversations.newAction'))
    expect(html).toContain('lucide-plus')
  })

  test('the counter reflects the total conversation count, not just a filtered one', async () => {
    const html = await render({
      states: [
        taskState({ id: 'a' }, 'p1'),
        taskState({ id: 'b' }, 'p1'),
        taskState({ id: 'c' }, 'p2'),
      ],
    })
    expect(html).toContain('class="cvl-count"')
    expect(html).toMatch(/class="cvl-count">3</)
  })

  test('an empty column shows a zero counter', async () => {
    const html = await render({ states: [] })
    expect(html).toMatch(/class="cvl-count">0</)
  })

  test('the action button carries the primary accent styling, not a discreet link', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.cvl-action {'), SOURCE.indexOf('.cvl-action:hover'))
    expect(block).toContain('background: var(--cs-green-soft);')
    expect(block).toContain('border: 1px solid var(--cs-green-ring);')
  })
})

describe('search field: present, its right padding is COMPUTED, not fixed', () => {
  test('no query typed: no clear button, padding is the base clearance (36px, 0 icons)', async () => {
    const html = await render()
    expect(html).not.toContain('cvl-search-clear')
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
    expect(html).not.toContain('cvl-group-head')
  })

  test('conversations exist: no empty message', async () => {
    const html = await render({ states: [taskState()] })
    expect(html).not.toContain(t('conversations.empty'))
  })

  // `query` is internal state with no prop entry point: reaching isSearchEmpty
  // needs a simulated keystroke, unavailable to an SSR string render (no
  // @vue/test-utils/jsdom in this package). Same gap ConversationsColumn.test.ts
  // itself already accepts for the identical reason; pinned on source instead.
  test('the no-match branch is wired to its own key, distinct from the empty-column one', () => {
    expect(SOURCE).toContain("t('conversations.searchEmpty')")
    expect(SOURCE).toContain('v-else-if="isSearchEmpty"')
  })
})

describe('grouping: by project, unchanged from ConversationsColumn.vue', () => {
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
    expect((html.match(/cvl-group-head/g) ?? []).length).toBe(2)
  })

  test('groups are expanded by default: aria-expanded true, no closed body', async () => {
    const html = await render({ states: [taskState({ id: 'a' }, 'p1')] })
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('cvl-group-body--closed')
  })
})

describe('selection: highlighted rows come from the focus deck, not a single selection', () => {
  test('one key in the focus deck: aria-current on that row only', async () => {
    const open = taskState({ id: 'open-one' }, 'p1')
    const other = taskState({ id: 'other-one' }, 'p1')
    const html = await render({ states: [open, other], focusedKeys: ['p1/open-one'] })
    const rows = [...html.matchAll(/<button type="button" class="cvl-row-btn[^"]*"([^>]*)>/g)]
    expect(rows).toHaveLength(2)
    expect(rows.filter((m) => m[1]?.includes('aria-current="true"'))).toHaveLength(1)
  })

  test('several keys in the focus deck: aria-current on each pinned row', async () => {
    const first = taskState({ id: 'first' }, 'p1')
    const second = taskState({ id: 'second' }, 'p1')
    const third = taskState({ id: 'third' }, 'p1')
    const html = await render({
      states: [first, second, third],
      focusedKeys: ['p1/first', 'p1/third'],
    })
    const rows = [...html.matchAll(/<button type="button" class="cvl-row-btn[^"]*"([^>]*)>/g)]
    expect(rows).toHaveLength(3)
    expect(rows.filter((m) => m[1]?.includes('aria-current="true"'))).toHaveLength(2)
  })

  test('no key in the focus deck: no row carries aria-current', async () => {
    const open = taskState({ id: 'open-one' }, 'p1')
    const other = taskState({ id: 'other-one' }, 'p1')
    const html = await render({ states: [open, other], focusedKeys: [] })
    const rows = [...html.matchAll(/<button type="button" class="cvl-row-btn[^"]*"([^>]*)>/g)]
    expect(rows).toHaveLength(2)
    expect(rows.some((m) => m[1]?.includes('aria-current="true"'))).toBe(false)
  })

  test('a selected row is a tinted fill, never a border', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvl-row-btn--selected {'),
      SOURCE.indexOf('.cvl-row-btn--selected :deep'),
    )
    expect(rule).toContain('background: var(--cs-green-soft);')
    expect(rule).not.toContain('border')
  })
})

describe('root: no fixed width, occupies the parent slot', () => {
  test('the root style carries no width/min-width/max-width pixel values', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.cvl-root {'), SOURCE.indexOf('.cvl-header {'))
    expect(root).not.toMatch(/\bwidth:\s*\d+px/)
    expect(root).not.toContain('min-width:')
    expect(root).not.toContain('max-width:')
    expect(root).toContain('width: 100%;')
  })
})

describe('header degradation thresholds: CSS-pinned, same values as the sheet', () => {
  test('the action label hides under 256px', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('@container cvl-shell (max-width: 256px)'),
      SOURCE.indexOf('@container cvl-shell (max-width: 256px)') + 120,
    )
    expect(rule).toContain('.cvl-action-label')
    expect(rule).toContain('display: none;')
  })

  test('the heading (title + counter) hides under 200px', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('@container cvl-shell (max-width: 200px)'),
      SOURCE.indexOf('@container cvl-shell (max-width: 200px)') + 100,
    )
    expect(rule).toContain('.cvl-heading')
    expect(rule).toContain('display: none;')
  })

  test('the container is self-named on the panel root, matching what the queries above target', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.cvl-root {'), SOURCE.indexOf('.cvl-header {'))
    expect(root).toContain('container-type: inline-size;')
    expect(root).toContain('container-name: cvl-shell;')
  })
})

describe('group collapse: a 1fr/0fr grid track, inert when closed', () => {
  test('the closed body track goes to 0fr and is hidden, never a fixed height', () => {
    const closed = SOURCE.slice(
      SOURCE.indexOf('.cvl-group-body--closed {'),
      SOURCE.indexOf('.cvl-group-body-inner {'),
    )
    expect(closed).toContain('grid-template-rows: 0fr;')
    expect(closed).toContain('visibility: hidden;')
    expect(closed).not.toContain('height:')
  })

  test('the template binds `inert` to the closed state, not merely a CSS class', () => {
    expect(SOURCE).toContain(':inert="!isOpen(group.projectId)"')
  })
})

describe('imports: reuses ConversationsLogic.ts and ConversationRow.vue unmodified', () => {
  test('the logic helpers are imported from the conversations directory, not reimplemented', () => {
    expect(SOURCE).toContain("from '../conversations/ConversationsLogic'")
    expect(SOURCE).toContain('groupConversationsByProject')
    expect(SOURCE).toContain('searchRightPadding')
  })

  test('ConversationRow is imported from the conversations directory', () => {
    expect(SOURCE).toContain("import ConversationRow from '../conversations/ConversationRow.vue'")
  })
})
