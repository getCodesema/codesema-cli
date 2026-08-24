// Same harness as ForgeBoard.test.ts / ForgeListPanel.test.ts for the
// SSR-string-rendered cases (every prop-driven state). One block at the
// bottom mounts on a null Vue renderer instead, mirroring TaskComposer.test.ts's
// own precedent: the label search's open/close-clears-the-query behavior is
// internal component state with no prop to seed it through, and SSR "runs
// setup and stops" (same limitation TaskComposer.test.ts's own comment
// names), so it cannot observe a click's effect at all.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createRenderer, createSSRApp, nextTick } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeIssuesResult, ForgeLabel, ForgeMr } from '../../types'
import type { ForgeSortKey, MrStateFilter } from './ForgeLogic'
import type { ForgeSection } from './ForgePrefs'

const SOURCE = readFileSync(join(import.meta.dir, 'ForgeControlsPanel.vue'), 'utf8')

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

function label(name: string): ForgeLabel {
  return { name, color: null }
}

function issue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1,
    title: 'first issue',
    body: '',
    state: 'open',
    labels: [],
    author: 'octocat',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/issues/1',
    ...overrides,
  }
}

function mr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 42,
    title: 'first mr',
    author: 'octocat',
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/mr/42',
    state: 'open',
    isDraft: false,
    labels: [],
    additions: null,
    deletions: null,
    changedFiles: null,
    checks: null,
    reviewers: null,
    assignees: null,
    milestone: null,
    mergeable: null,
    commits: null,
    body: null,
    ...overrides,
  }
}

function issuesState(overrides: Partial<ProjectIssuesState> = {}): ProjectIssuesState {
  return { result: null, loading: false, error: null, ...overrides }
}

function available(issues: ForgeIssue[], truncated = false): ForgeIssuesResult {
  return { available: true, truncated, issues }
}

type Props = {
  activeSection: ForgeSection
  collapsed: boolean
  projectName: string
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsFilter: MrStateFilter
  mrsLabels: string[]
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    activeSection: 'issues',
    collapsed: false,
    projectName: 'demo',
    issuesState: issuesState(),
    issuesSort: 'updated',
    issuesLabels: [],
    mrs: [],
    mrsState: null,
    mrsSort: 'updated',
    mrsFilter: 'all',
    mrsLabels: [],
    ...overrides,
  }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const ForgeControlsPanel = (await import('./ForgeControlsPanel.vue')).default
  const app = createSSRApp(ForgeControlsPanel, props(overrides))
  return renderToString(app)
}

describe('both accordion headers always render; only the active section has a body', () => {
  test('issues active: its body renders, the pull requests body does not', async () => {
    const html = await render({ activeSection: 'issues' })
    expect(html).toContain(t('forge.issuesTitle'))
    expect(html).toContain(t('forge.mrsTitle'))
    expect(html).toContain('id="fcp-body-issues"')
    expect(html).not.toContain('id="fcp-body-mrs"')
  })

  test('pull requests active: its body renders, the issues body does not', async () => {
    const html = await render({ activeSection: 'mrs' })
    expect(html).toContain('id="fcp-body-mrs"')
    expect(html).not.toContain('id="fcp-body-issues"')
  })

  test('the collapse toggle reads "collapse", expanded (aria-expanded true)', async () => {
    const html = await render()
    expect(html).toContain(t('forge.controlsCollapse'))
    expect(html).not.toContain(t('forge.controlsExpand'))
    expect(html).toContain('aria-expanded="true"')
  })

  test('no collapsed band while expanded', async () => {
    const html = await render()
    expect(html).not.toContain('fcp-band')
  })
})

/** The two accordion head buttons, in DOM order, as [ariaExpanded, closedChevron] pairs. */
function headsOf(html: string): Array<{ expanded: string; chevronClosed: boolean }> {
  const pattern =
    /<button type="button" class="fcp-acc-head" aria-expanded="(true|false)"[^>]*>[\s\S]*?<svg class="fcp-acc-chevron( fcp-acc-chevron--closed)?"/g
  return [...html.matchAll(pattern)].map((m) => ({
    expanded: m[1] ?? '',
    chevronClosed: Boolean(m[2]),
  }))
}

describe('accordion headers: aria-expanded and the chevron follow the active section', () => {
  test('issues active: its header is expanded with an un-rotated chevron, the other is not', async () => {
    const html = await render({ activeSection: 'issues' })
    const heads = headsOf(html)
    expect(heads).toEqual([
      { expanded: 'true', chevronClosed: false },
      { expanded: 'false', chevronClosed: true },
    ])
  })

  test('pull requests active: its header is expanded, issues is closed', async () => {
    const html = await render({ activeSection: 'mrs' })
    const heads = headsOf(html)
    expect(heads).toEqual([
      { expanded: 'false', chevronClosed: true },
      { expanded: 'true', chevronClosed: false },
    ])
  })
})

// The rotation itself is CSS-only, unreachable through an SSR string render
// (same limitation as ForgeControlsPanel's own former band-orientation test).
describe('chevron rotation and the filter separator geometry: CSS-pinned', () => {
  test('the chevron rotates 90 degrees when its section is closed, animated over 150ms', () => {
    const chevron = SOURCE.slice(
      SOURCE.indexOf('.fcp-acc-chevron {'),
      SOURCE.indexOf('.fcp-acc-body {'),
    )
    expect(chevron).toContain('transition: transform 150ms ease;')
    expect(chevron).toContain('transform: rotate(-90deg);')
  })

  test('the separator sits 4px from the rows above and below, 1px tall', () => {
    const sep = SOURCE.slice(SOURCE.indexOf('.fcp-filter-sep {'), SOURCE.indexOf('.fcp-reset {'))
    expect(sep).toContain('height: 1px;')
    expect(sep).toContain('margin: 4px 0;')
  })

  test('a selected row never gets a border, only an accent-soft fill and weight 500', () => {
    const on = SOURCE.slice(SOURCE.indexOf('.fcp-row--on {'), SOURCE.indexOf('.fcp-row-icon {'))
    expect(on).toContain('background: var(--cs-green-soft);')
    expect(on).toContain('font-weight: 500;')
    expect(on).not.toContain('border')
  })

  test('a row lights up on hover', () => {
    const hover = SOURCE.slice(SOURCE.indexOf('.fcp-row:hover {'), SOURCE.indexOf('.fcp-row--on {'))
    expect(hover).toContain('background: var(--cs-hover);')
  })
})

describe('issues section: sort rows, gated on there being data to control', () => {
  test('no data loaded yet: no sort block, no labels block', async () => {
    const html = await render({ activeSection: 'issues', issuesState: issuesState() })
    expect(html).not.toContain('fcp-block')
  })

  test('an empty, loaded list: no sort block either (nothing to control)', async () => {
    const html = await render({
      activeSection: 'issues',
      issuesState: issuesState({ result: available([]) }),
    })
    expect(html).not.toContain('fcp-block')
  })

  test('sort rows carry role=radio and aria-checked reflecting the current sort', async () => {
    const updated = await render({
      activeSection: 'issues',
      issuesState: issuesState({ result: available([issue()]) }),
      issuesSort: 'updated',
    })
    expect(updated).toContain('role="radiogroup"')
    const rows = [
      ...updated.matchAll(/class="fcp-row[^"]*" role="radio" aria-checked="(true|false)"/g),
    ]
    expect(rows.map((m) => m[1])).toEqual(['true', 'false'])

    const title = await render({
      activeSection: 'issues',
      issuesState: issuesState({ result: available([issue()]) }),
      issuesSort: 'title',
    })
    const titleRows = [
      ...title.matchAll(/class="fcp-row[^"]*" role="radio" aria-checked="(true|false)"/g),
    ]
    expect(titleRows.map((m) => m[1])).toEqual(['false', 'true'])
  })

  test('issues carry no status-filter block: only labels can narrow this section', async () => {
    const html = await render({
      activeSection: 'issues',
      issuesState: issuesState({ result: available([issue()]) }),
    })
    expect(html).not.toContain(t('forge.controlsFiltersHeading'))
    expect(html).not.toContain('fcp-filter-sep')
  })

  test('label chips render from the loaded issues', async () => {
    const html = await render({
      activeSection: 'issues',
      issuesState: issuesState({ result: available([issue({ labels: [label('bug')] })]) }),
    })
    expect(html).toContain('bug')
    expect(html).toContain('lc-chip')
  })
})

describe('pull requests section: sort, status filter (draft/ready only), labels', () => {
  test('no data (unavailable or empty): no controls at all', async () => {
    const unavailable = await render({
      activeSection: 'mrs',
      mrs: [mr()],
      mrsState: { status: 'unavailable', reason: 'no-cli' },
    })
    expect(unavailable).not.toContain('fcp-block')

    const empty = await render({
      activeSection: 'mrs',
      mrs: [],
      mrsState: { status: 'loaded', truncated: false },
    })
    expect(empty).not.toContain('fcp-block')
  })

  test('only draft/ready are offered, never "all" as a row: the corpus cannot honor open/merged/closed', async () => {
    const html = await render({
      activeSection: 'mrs',
      mrs: [mr()],
      mrsState: { status: 'loaded', truncated: false },
    })
    expect(html).toContain(t('forge.filterDraft'))
    expect(html).toContain(t('forge.filterReady'))
  })

  test('the exclusive filter rows carry role=radio and aria-checked, no separator (no cumulable toggle exists yet)', async () => {
    const html = await render({
      activeSection: 'mrs',
      mrs: [mr()],
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'draft',
    })
    expect(html).toContain('fcp-row-list" role="radiogroup" aria-label="' + t('forge.filterAria'))
    expect(html).not.toContain('fcp-filter-sep')
  })

  test('the reset link only shows once the status filter is active, and reads "reset"', async () => {
    const inactive = await render({
      activeSection: 'mrs',
      mrs: [mr()],
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'all',
    })
    expect(inactive).not.toContain('fcp-reset')

    const active = await render({
      activeSection: 'mrs',
      mrs: [mr()],
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'draft',
    })
    expect(active).toContain('fcp-reset')
    expect(active).toContain(t('forge.controlsFiltersReset'))
  })

  test('label chips render from the loaded MRs', async () => {
    const html = await render({
      activeSection: 'mrs',
      mrs: [mr({ labels: [label('needs-review')] })],
      mrsState: { status: 'loaded', truncated: false },
    })
    expect(html).toContain('needs-review')
    expect(html).toContain('lc-chip')
  })
})

describe('label search: closed by default in both sections', () => {
  test('issues: the magnifier is not accented, no search field is rendered', async () => {
    const html = await render({
      activeSection: 'issues',
      issuesState: issuesState({ result: available([issue({ labels: [label('bug')] })]) }),
    })
    expect(html).not.toContain('fcp-search-toggle--on')
    expect(html).not.toContain('fcp-label-search-input')
  })

  test('pull requests: same rest state', async () => {
    const html = await render({
      activeSection: 'mrs',
      mrs: [mr({ labels: [label('bug')] })],
      mrsState: { status: 'loaded', truncated: false },
    })
    expect(html).not.toContain('fcp-search-toggle--on')
    expect(html).not.toContain('fcp-label-search-input')
  })
})

describe('collapsed: a full-band reopen control carrying the project name, no sections', () => {
  test('neither accordion head is rendered as a nav button', async () => {
    const html = await render({ collapsed: true })
    expect(html).not.toContain('fcp-acc-head')
  })

  test('the band carries the project name, truncatable, and reads as the expand control', async () => {
    const html = await render({ collapsed: true, projectName: 'my-repo' })
    expect(html).toContain('class="fcp-band"')
    expect(html).toContain('class="fcp-band-name"')
    expect(html).toContain('>my-repo<')
    expect(html).toContain('title="my-repo"')
    expect(html).toContain(t('forge.controlsExpand'))
    expect(html).not.toContain(t('forge.controlsCollapse'))
    expect(html).toContain('aria-expanded="false"')
  })

  test('the whole band is a single button element (the entire strip reopens it)', async () => {
    const html = await render({ collapsed: true })
    expect((html.match(/<button/g) ?? []).length).toBe(1)
  })
})

// The writing-mode flip is CSS-only, unreachable through an SSR string
// render (same limitation as ProjectsNav.test.ts's own geometry pins).
describe('the band orientation: CSS-pinned', () => {
  test('the name is vertical, top-to-bottom, by default', () => {
    const bandName = SOURCE.slice(
      SOURCE.indexOf('.fcp-band-name {'),
      SOURCE.indexOf('/* Below the shell'),
    )
    expect(bandName).toContain('writing-mode: vertical-rl;')
  })

  test("below the shell's own 640px, the band becomes horizontal, the name no longer rotated", () => {
    const narrow = SOURCE.slice(SOURCE.indexOf('@container fb-shell (max-width: 640px) {'))
    expect(narrow).toContain('writing-mode: horizontal-tb;')
    expect(narrow).toContain('height: 48px;')
  })
})

// ── Interactive: mounted on a null Vue renderer, same escape hatch as
// TaskComposer.test.ts (see its own comment). This is the one behavior SSR
// genuinely cannot observe: the search box is internal ref state with no
// prop seeding it, and clicking it is exactly the interaction SSR "runs
// setup and stops" before ever reaching. ──
type FakeNode = {
  tag: string
  text: string
  parent: FakeNode | null
  children: FakeNode[]
  attrs: Record<string, unknown>
  listeners: Record<string, (event?: unknown) => void>
  value: string
  focus: () => void
  addEventListener: () => void
  removeEventListener: () => void
}

function fakeNode(tag: string): FakeNode {
  return {
    tag,
    text: '',
    parent: null,
    children: [],
    attrs: {},
    listeners: {},
    value: '',
    focus: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

const { createApp: createNullApp } = createRenderer<FakeNode, FakeNode>({
  createElement: (tag) => fakeNode(tag),
  createText: (text) => Object.assign(fakeNode('#text'), { text }),
  createComment: (text) => Object.assign(fakeNode('#comment'), { text }),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  insert: (child, parent, anchor) => {
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at === -1) {
      parent.children.push(child)
    } else {
      parent.children.splice(at, 0, child)
    }
  },
  remove: (child) => {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  // The compiler stringifies large fully-static subtrees (this panel's many
  // static SVG icon paths qualify): the renderer must be able to insert an
  // opaque block for them even though this fake DOM cannot parse HTML. Its
  // own content is never inspected by these tests, only its two anchors.
  insertStaticContent: (content, parent, anchor) => {
    const node = fakeNode('#static')
    node.text = content
    node.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at === -1) {
      parent.children.push(node)
    } else {
      parent.children.splice(at, 0, node)
    }
    return [node, node]
  },
  patchProp: (el, key, _prev, next) => {
    if (key.startsWith('on') && key.length > 2) {
      const event = (key[2] as string).toLowerCase() + key.slice(3)
      el.listeners[event] = next as (event?: unknown) => void
      return
    }
    if (key === 'value') {
      el.value = typeof next === 'string' ? next : ''
    }
    el.attrs[key] = next
  },
})

function findAll(root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (n: FakeNode): void => {
    if (pred(n)) {
      out.push(n)
    }
    for (const child of n.children) {
      walk(child)
    }
  }
  walk(root)
  return out
}

function find(root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode | null {
  return findAll(root, pred)[0] ?? null
}

function hasClass(node: FakeNode, cls: string): boolean {
  const value = node.attrs.class
  return typeof value === 'string' && value.split(/\s+/).includes(cls)
}

describe('label search: opening, typing, closing clears the query (interactive)', () => {
  async function mountControls(): Promise<FakeNode> {
    const ForgeControlsPanel = (await import('./ForgeControlsPanel.vue')).default
    const root = fakeNode('#root')
    const app = createNullApp(
      ForgeControlsPanel,
      props({
        activeSection: 'issues',
        issuesState: issuesState({
          result: available([issue({ labels: [label('bug'), label('ui')] })]),
        }),
      }),
    )
    app.mount(root)
    await nextTick()
    await nextTick()
    return root
  }

  test('closed by default, opens on click, and closing after typing clears the query on reopen', async () => {
    const root = await mountControls()

    expect(find(root, (n) => hasClass(n, 'fcp-label-search'))).toBeNull()

    const toggle = find(root, (n) => hasClass(n, 'fcp-search-toggle'))
    expect(toggle).not.toBeNull()
    toggle?.listeners.click?.()
    await nextTick()
    await nextTick()

    const input = find(root, (n) => hasClass(n, 'fcp-label-search-input'))
    expect(input).not.toBeNull()

    if (input) {
      input.value = 'bu'
      input.listeners.input?.({ target: input })
    }
    await nextTick()

    const close = find(root, (n) => hasClass(n, 'fcp-label-search-close'))
    expect(close).not.toBeNull()
    close?.listeners.click?.()
    await nextTick()

    expect(find(root, (n) => hasClass(n, 'fcp-label-search'))).toBeNull()

    toggle?.listeners.click?.()
    await nextTick()
    await nextTick()

    const reopened = find(root, (n) => hasClass(n, 'fcp-label-search-input'))
    expect(reopened).not.toBeNull()
    expect(reopened?.value).toBe('')
  })
})
