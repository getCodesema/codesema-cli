// ForgeBoard is the two-panel board (list / detail). The controls are NOT
// here: they live in the desk's permanent left rail, so their tests live in
// ForgeControlsPanel.test.ts and WorkspaceView.test.ts.
//
// Same harness as elsewhere: SSR string rendering, no live DOM, so
// interaction is exercised through props rather than simulated clicks. The
// board no longer reads `localStorage` at all: its caller owns the
// preferences and hands them down, which is why every test here is a plain
// prop bag. `initialSelection` (see the prop's own doc in ForgeBoard.vue) is
// the seam that lets this file drive the detail panel without a click.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeIssuesResult, ForgeMr } from '../../types'
import type { ForgeSelection } from './ForgeLogic'
import { FORGE_LIST_WIDTH_DEFAULT, type ForgeSection } from './ForgePrefs'

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
  /** All of the below now come from the caller instead of a persisted blob,
   * and default here to what the shared preferences default to. */
  section?: ForgeSection
  issuesSort?: 'updated' | 'title'
  mrsSort?: 'updated' | 'title'
  mrsFilter?: 'all' | 'draft' | 'ready'
  issuesLabels?: string[]
  mrsLabels?: string[]
  listWidth?: number
  initialSelection?: ForgeSelection | null
}

async function render(props: RenderProps): Promise<string> {
  const ForgeBoard = (await import('./ForgeBoard.vue')).default
  const app = createSSRApp(ForgeBoard, {
    section: 'issues',
    issuesSort: 'updated',
    mrsSort: 'updated',
    mrsFilter: 'all',
    issuesLabels: [],
    mrsLabels: [],
    listWidth: FORGE_LIST_WIDTH_DEFAULT,
    ...props,
  })
  return renderToString(app)
}

const noMrs: RenderProps = { issuesState: issuesState(), mrs: [], mrsState: null }

describe('the list width comes from the caller, never from storage', () => {
  test('the default width is reflected', async () => {
    const html = await render(noMrs)
    expect(html).toContain(`--fb-list-w:${FORGE_LIST_WIDTH_DEFAULT}px`)
  })

  test('a width passed in is honored', async () => {
    const html = await render({ ...noMrs, listWidth: 420 })
    expect(html).toContain('--fb-list-w:420px')
  })

  // The rail's own width and collapsed state are no longer this component's
  // business at all: it renders one splitter, between list and detail.
  test('the board renders the list splitter and no controls splitter', async () => {
    const html = await render(noMrs)
    expect(html).toContain(t('forge.resizeListAria'))
    expect(html).not.toContain(t('forge.resizeControlsAria'))
  })

  test('the board renders no controls panel and no collapsed band', async () => {
    const html = await render(noMrs)
    expect(html).not.toContain('fcp-band')
    expect(html).not.toContain('fcp-sections')
  })
})

/** The list panel's own heading (`flp-heading`). */
function listHeadingOf(html: string): string | null {
  return /<span class="flp-heading">([^<]*)<\/span>/.exec(html)?.[1] ?? null
}

describe('the section prop picks which list the list panel shows', () => {
  test('section: issues shows the issues heading, not pull requests', async () => {
    const html = await render({
      section: 'issues',
      issuesState: issuesState({ result: available([issue()]) }),
      mrs: [mr()],
      mrsState: null,
    })
    expect(listHeadingOf(html)).toBe(t('forge.issuesTitle'))
  })

  test('section: mrs shows the pull requests heading, not issues', async () => {
    const html = await render({
      section: 'mrs',
      issuesState: issuesState({ result: available([issue()]) }),
      mrs: [mr()],
      mrsState: { status: 'loaded', truncated: false },
    })
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
      section: 'mrs',
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
