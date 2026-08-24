// ForgeBoard is the three-panel shell (controls / list / detail). Same
// harness as elsewhere: SSR string rendering, no live DOM, so interaction is
// exercised through props and a seeded `localStorage` blob rather than
// simulated clicks; the detailed list/controls/detail content itself is
// covered by ForgeListPanel.test.ts / ForgeControlsPanel.test.ts /
// ForgeDetailPanel.test.ts. `initialSelection` (see the prop's own doc in
// ForgeBoard.vue) is the seam that lets this file drive the detail panel's
// appearance without a click.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeIssuesResult, ForgeMr } from '../../types'
import type { ForgeSelection } from './ForgeLogic'
import {
  DEFAULT_FORGE_PREFS,
  FORGE_CONTROLS_COLLAPSED_WIDTH,
  FORGE_CONTROLS_WIDTH_DEFAULT,
  FORGE_LIST_WIDTH_DEFAULT,
  type ForgePrefs,
} from './ForgePrefs'

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

type RenderProps = {
  issuesState: ProjectIssuesState
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  initialSelection?: ForgeSelection | null
  /** Defaults to 'demo': irrelevant to most tests, only the collapsed-band
   * tests below actually vary it. */
  projectName?: string
}

async function render(props: RenderProps): Promise<string> {
  const ForgeBoard = (await import('./ForgeBoard.vue')).default
  const app = createSSRApp(ForgeBoard, { projectName: 'demo', ...props })
  return renderToString(app)
}

/** Renders with a seeded persisted prefs blob, restoring the real
 * `localStorage` afterward. */
async function renderWithPrefs(
  prefsOverrides: Partial<ForgePrefs>,
  props: RenderProps,
): Promise<string> {
  const store = new Map<string, string>()
  store.set(
    'codesema-ws-forge-prefs',
    JSON.stringify({ ...DEFAULT_FORGE_PREFS, ...prefsOverrides }),
  )
  const stub = { getItem: (key: string) => store.get(key) ?? null, setItem: () => {} }
  const globals = globalThis as { localStorage?: unknown }
  const previous = globals.localStorage
  try {
    globals.localStorage = stub
    return await render(props)
  } finally {
    globals.localStorage = previous
  }
}

const noMrs: RenderProps = { issuesState: issuesState(), mrs: [], mrsState: null }

describe('panel widths: reflected from the persisted prefs, falling back to the defaults', () => {
  test('default widths (no persisted prefs) are the documented defaults', async () => {
    const html = await render(noMrs)
    expect(html).toContain(`--fb-controls-w:${FORGE_CONTROLS_WIDTH_DEFAULT}px`)
    expect(html).toContain(`--fb-list-w:${FORGE_LIST_WIDTH_DEFAULT}px`)
  })

  test('a persisted controlsWidth/listWidth is honored', async () => {
    const html = await renderWithPrefs({ controlsWidth: 340, listWidth: 420 }, noMrs)
    expect(html).toContain('--fb-controls-w:340px')
    expect(html).toContain('--fb-list-w:420px')
  })
})

describe('the controls panel collapses to its rail width, independent of the stored width to restore', () => {
  test('collapsed: true pins the controls panel at the collapsed-rail width', async () => {
    const html = await renderWithPrefs({ controlsCollapsed: true, controlsWidth: 340 }, noMrs)
    expect(html).toContain(`--fb-controls-w:${FORGE_CONTROLS_COLLAPSED_WIDTH}px`)
  })

  test('collapsed: true hides the controls resize handle, the list/detail one stays (the detail panel is always on screen)', async () => {
    const html = await renderWithPrefs({ controlsCollapsed: true }, noMrs)
    expect(html).not.toContain(t('forge.resizeControlsAria'))
    expect(html).toContain(t('forge.resizeListAria'))
  })

  test('collapsed: false shows both resize handles', async () => {
    const html = await renderWithPrefs({ controlsCollapsed: false }, noMrs)
    expect(html).toContain(t('forge.resizeControlsAria'))
    expect(html).toContain(t('forge.resizeListAria'))
  })

  // The collapsed band carries the selected project's name through from
  // WorkspaceView (:project-name), not a bare toggle.
  test('collapsed: the band carries the project name passed in', async () => {
    const html = await renderWithPrefs(
      { controlsCollapsed: true },
      { ...noMrs, projectName: 'my-repo' },
    )
    expect(html).toContain('class="fcp-band"')
    expect(html).toContain('>my-repo<')
  })

  test('expanded: no collapsed band, the section nav shows instead', async () => {
    const html = await renderWithPrefs(
      { controlsCollapsed: false },
      { ...noMrs, projectName: 'my-repo' },
    )
    expect(html).not.toContain('fcp-band')
  })
})

/** The list panel's own heading (`flp-heading`): the controls panel's
 * section nav always names BOTH sections regardless of which is active, so
 * an assertion about which section is actually SHOWN must read only this. */
function listHeadingOf(html: string): string | null {
  return /<span class="flp-heading">([^<]*)<\/span>/.exec(html)?.[1] ?? null
}

describe('the active section (persisted) picks which list the list panel shows', () => {
  test('activeSection: issues shows the issues heading, not pull requests', async () => {
    const html = await renderWithPrefs(
      { activeSection: 'issues' },
      { issuesState: issuesState({ result: available([issue()]) }), mrs: [mr()], mrsState: null },
    )
    expect(listHeadingOf(html)).toBe(t('forge.issuesTitle'))
  })

  test('activeSection: mrs shows the pull requests heading, not issues', async () => {
    const html = await renderWithPrefs(
      { activeSection: 'mrs' },
      {
        issuesState: issuesState({ result: available([issue()]) }),
        mrs: [mr()],
        mrsState: { status: 'loaded', truncated: false },
      },
    )
    expect(listHeadingOf(html)).toBe(t('forge.mrsTitle'))
  })
})

// The detail panel stays on screen at all times, its splitter too. What
// changes with the selection is its CONTENT: the empty state, or the
// selected item's card.
describe('the detail panel is always present, with an empty state until something is selected', () => {
  test('no initial selection: the panel and its splitter are there, showing the empty state', async () => {
    const html = await render(noMrs)
    expect(html).toContain('fb-panel--detail')
    expect(html).toContain(t('forge.resizeListAria'))
    expect(html).toContain(t('forge.detailEmpty'))
    expect(html).not.toContain(t('forge.detailTitle'))
  })

  test('a selection matching a loaded issue replaces the empty state with that issue', async () => {
    const html = await render({
      issuesState: issuesState({
        result: available([issue({ number: 3, title: 'the selected one' })]),
      }),
      mrs: [],
      mrsState: null,
      initialSelection: { kind: 'issue', number: 3 },
    })
    expect(html).toContain(t('forge.detailTitle'))
    expect(html).toContain('the selected one')
    expect(html).not.toContain(t('forge.detailEmpty'))
  })

  test('a selection matching a loaded MR replaces the empty state with that MR', async () => {
    const html = await render({
      issuesState: issuesState(),
      mrs: [mr({ number: 8, title: 'the selected mr' })],
      mrsState: { status: 'loaded', truncated: false },
      initialSelection: { kind: 'mr', number: 8 },
    })
    expect(html).toContain('the selected mr')
    expect(html).not.toContain(t('forge.detailEmpty'))
  })

  test('a selection whose item is not in the loaded list falls back to the empty state, never a stale card', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([issue({ number: 1 })]) }),
      mrs: [],
      mrsState: null,
      initialSelection: { kind: 'issue', number: 999 },
    })
    expect(html).toContain(t('forge.detailEmpty'))
  })

  test('a selection made before the issues list has loaded falls back to the empty state, never a stale card', async () => {
    const html = await render({
      issuesState: issuesState(),
      mrs: [],
      mrsState: null,
      initialSelection: { kind: 'issue', number: 1 },
    })
    expect(html).toContain(t('forge.detailEmpty'))
  })
})
