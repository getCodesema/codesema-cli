// Same harness as the other rail tests, on this component's own source.
// Container query thresholds are CSS-only, unreachable through an SSR string
// render, so those are pinned by slicing the raw source instead.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { TaskState } from '../../composables/useTasks'
import { G } from '../../glyphs'
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
  focusedKeys: readonly string[]
}

function props(overrides: Partial<Props> = {}): Props {
  return { states: [], focusedKeys: [], ...overrides }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const ConversationsList = (await import('./ConversationsList.vue')).default
  const app = createSSRApp(ConversationsList, props(overrides))
  return renderToString(app)
}

describe('header: the kit rail head, a title and a + action', () => {
  test('the title renders and the create action is a plain + button, no icon', async () => {
    const html = await render()
    expect(html).toContain('class="cvl-header rail-h"')
    expect(html).toContain(t('conversations.title'))
    expect(html).toContain(t('conversations.newAction'))
    expect(html).toContain('class="cvl-action"')
    expect(html).not.toContain('lucide')
    expect(html).not.toContain('btn')
  })

  test('the action is the kit rail-h button: accent, borderless, no fill', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.cvl-action {'), SOURCE.indexOf('.cvl-action:hover'))
    expect(block).toContain('color: var(--accent);')
    expect(block).toContain('border: 0;')
    expect(block).not.toContain('background: var(')
  })

  test('no counter of any kind rides in the chrome', async () => {
    const html = await render({ states: [taskState({ id: 'a' }, 'p1')] })
    expect(html).not.toContain('cvl-count')
  })
})

describe('search field: borderless, glyph-led, its right padding still COMPUTED', () => {
  test('no query typed: no clear button, padding is the base clearance (36px, 0 icons)', async () => {
    const html = await render()
    expect(html).not.toContain('cvl-search-clear')
    expect(html).toContain('padding-right:36px')
  })

  test('placeholder text comes from i18n', async () => {
    const html = await render()
    expect(html).toContain(t('conversations.searchPlaceholder'))
  })

  test('the search glyph is the kit one, from G, never a lucide icon', async () => {
    const html = await render()
    expect(html).toContain(`class="cvl-search-glyph" aria-hidden="true">${G.search}<`)
  })

  test('the input carries no frame of its own', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvl-search-input {'),
      SOURCE.indexOf('.cvl-search-input:focus'),
    )
    expect(rule).toContain('border: 0;')
    expect(rule).toContain('background: transparent;')
  })

  test('the filter runs on the shared matchesQuery, never a local title comparison', () => {
    expect(SOURCE).toContain('matchesQuery(s.record, query.value)')
  })
})

describe('empty states: no conversation at all vs. a search matching nothing', () => {
  test('no conversation anywhere: the empty message, no list', async () => {
    const html = await render({ states: [] })
    expect(html).toContain(t('conversations.empty'))
    expect(html).not.toContain('cvl-row-btn')
  })

  test('conversations exist: no empty message', async () => {
    const html = await render({ states: [taskState()] })
    expect(html).not.toContain(t('conversations.empty'))
  })

  // `query` is internal state with no prop entry point: reaching isSearchEmpty
  // needs a simulated keystroke, unavailable to an SSR string render (no
  // @vue/test-utils/jsdom in this package). Same gap the rail tests
  // itself already accepts for the identical reason; pinned on source instead.
  test('the no-match branch is wired to its own key, distinct from the empty-column one', () => {
    expect(SOURCE).toContain("t('conversations.searchEmpty')")
    expect(SOURCE).toContain('v-else-if="isSearchEmpty"')
  })
})

describe('flat list: a conversation is not a child of a project', () => {
  test('conversations of several projects share ONE list, with no project row', async () => {
    const html = await render({
      states: [
        taskState({ id: 'a' }, 'p1'),
        taskState({ id: 'b' }, 'p1'),
        taskState({ id: 'c' }, 'p2'),
      ],
    })
    expect((html.match(/cvl-row-btn/g) ?? []).length).toBe(3)
    expect(html).not.toContain('cvl-group')
    expect(html).not.toContain('proj')
    expect(html).not.toContain('aria-expanded')
  })

  test('a conversation carrying no project renders like any other line', async () => {
    const html = await render({ states: [taskState({ id: 'orphan', title: 'no project' }, '')] })
    expect(html).toContain('no project')
    expect((html.match(/cvl-row-btn/g) ?? []).length).toBe(1)
  })

  test('the project name is never read here: no such prop, no such lookup', () => {
    expect(SOURCE).not.toContain('projectNames')
    expect(SOURCE).not.toContain('projectName')
  })
})

describe('lines: one conversation, one inset line between two hairlines', () => {
  test('a line is framed by a top hairline (and a bottom one on the last), inset from the rail edges', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvl-row-btn {'),
      SOURCE.indexOf('.cvl-row-btn:hover {'),
    )
    expect(rule).toContain('border-top: 1px solid var(--line);')
    expect(rule).toContain('.cvl-row-btn:last-child {\n  border-bottom: 1px solid var(--line);')
    expect(rule).toContain('margin: 0 1ch;')
    expect(rule).toContain('width: calc(100% - 2ch);')
    expect(rule).toContain('background: transparent;')
    expect(rule).not.toContain('border-radius')
    expect(rule).not.toContain('box-shadow')
  })

  test('the list is spaced by text lines, never by a gap of pixels', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cvl-list {'), SOURCE.indexOf('@container'))
    expect(rule).toContain('padding: calc(var(--row) / 2) 0;')
    expect(rule).not.toMatch(/padding:[^;]*\d+px/)
  })
})

describe('ordering: attention first, straight from the shared logic', () => {
  test('the order comes from orderConversations, not a local sort', () => {
    expect(SOURCE).toContain('orderConversations(filteredStates.value)')
    expect(SOURCE).not.toContain('.toSorted(')
  })

  test('waiting, then running, then queued, then finished', async () => {
    const html = await render({
      states: [
        taskState({ id: 'd', title: 'shipped one', status: 'shipped' }, 'p1'),
        taskState({ id: 'c', title: 'queued one', status: 'queued' }, 'p1'),
        taskState({ id: 'b', title: 'running one', status: 'running' }, 'p1'),
        taskState({ id: 'a', title: 'waiting one', status: 'waiting_for_you' }, 'p1'),
      ],
    })
    expect(html.indexOf('waiting one')).toBeLessThan(html.indexOf('running one'))
    expect(html.indexOf('running one')).toBeLessThan(html.indexOf('shipped one'))
    expect(html.indexOf('queued one')).toBeLessThan(html.indexOf('shipped one'))
  })

  test('the finished pile opens on a single break, never a titled section', async () => {
    const html = await render({
      states: [
        taskState({ id: 'a', status: 'running' }, 'p1'),
        taskState({ id: 'b', status: 'shipped' }, 'p1'),
        taskState({ id: 'c', status: 'failed' }, 'p1'),
      ],
    })
    expect((html.match(/cvl-row-btn--finished-start/g) ?? []).length).toBe(1)
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvl-row-btn--finished-start {'),
      SOURCE.indexOf('.cvl-row-btn:hover {'),
    )
    expect(rule).toContain('margin-top: calc(var(--row) / 2);')
    expect(rule).not.toContain('border-top: 2px')
  })

  test('nothing finished: no break at all', async () => {
    const html = await render({ states: [taskState({ id: 'a', status: 'running' }, 'p1')] })
    expect(html).not.toContain('cvl-row-btn--finished-start')
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

  test('a selected line is a fill, never a border', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvl-row-btn--selected {'),
      SOURCE.indexOf('.cvl-footer {'),
    )
    expect(rule).toContain('background: var(--bg-hover);')
    expect(rule).not.toContain('border')
  })

  test('hover is the same fill, nothing else', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.cvl-row-btn:hover {'),
      SOURCE.indexOf('.cvl-row-btn--selected {'),
    )
    expect(rule).toContain('background: var(--bg-hover);')
  })
})

describe('actions: the + emits create, a line emits select', () => {
  test('the header action emits create and the line emits select with its state', () => {
    expect(SOURCE).toContain('@click="emit(\'create\')"')
    expect(SOURCE).toContain('@click="emit(\'select\', state)"')
  })

  test('Cmd/Ctrl+K still reaches the search box through focusSearch', () => {
    expect(SOURCE).toContain('defineExpose({ focusSearch: () => searchInput.value?.focus() })')
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

  test('no colour is spelled out: only theme tokens, never a plain hex', () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(SOURCE).not.toContain('rgba(')
  })

  test('no animation keeps a fill mode', () => {
    expect(SOURCE).not.toMatch(/animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/)
  })
})

describe('degradation thresholds: CSS-pinned, same values as the sheet', () => {
  test('the line age hides under 256px', () => {
    const at = SOURCE.indexOf('@container cvl-shell (max-width: 256px)')
    const rule = SOURCE.slice(at, at + 120)
    expect(rule).toContain('.cvr-age')
    expect(rule).toContain('display: none;')
  })

  test('the container is self-named on the panel root, matching what the queries above target', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.cvl-root {'), SOURCE.indexOf('.cvl-header {'))
    expect(root).toContain('container-type: inline-size;')
    expect(root).toContain('container-name: cvl-shell;')
  })
})

describe('footer: theme picker and settings stay reachable without the category rail', () => {
  test('ThemePicker compact and a settings emit live in the footer', () => {
    expect(SOURCE).toContain('<ThemePicker compact />')
    expect(SOURCE).toContain("emit('settings')")
    expect(SOURCE).toContain("t('nav.settings')")
  })

  test('the footer sits under the scrollable list', () => {
    expect(SOURCE.indexOf('cvl-scroll')).toBeLessThan(SOURCE.indexOf('cvl-footer'))
  })
})

describe('imports: reuses ConversationsLogic.ts and ConversationRow.vue unmodified', () => {
  test('the logic helpers are imported from the conversations directory, not reimplemented', () => {
    expect(SOURCE).toContain("from '../conversations/ConversationsLogic'")
    expect(SOURCE).toContain('orderConversations')
    expect(SOURCE).toContain('searchRightPadding')
  })

  test('ConversationRow is imported from the conversations directory', () => {
    expect(SOURCE).toContain("import ConversationRow from '../conversations/ConversationRow.vue'")
  })
})
