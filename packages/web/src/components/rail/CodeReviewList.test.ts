// SSR-only harness (no DOM, no click simulation), same convention as
// RepositoriesList.test.ts and ReviewTargetPanel.test.ts. Rows are built with
// the real buildCodeReviewRows (useCodeReview.ts) rather than hand-crafted
// CodeReviewRow literals: this component's own contract is "render what
// useCodeReview.ts already sorted and filtered", so a fixture bypassing that
// function could drift from what the row-building logic actually produces.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import {
  buildCodeReviewRows,
  codeReviewRowKey,
  type CodeReviewProjectInput,
  type CodeReviewRow,
} from '../../composables/useCodeReview'
import { t } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type {
  ForgeMr,
  LocalBranch,
  MrReviewStatus,
  Project,
  ReviewArchiveSummary,
} from '../../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'CodeReviewList.vue'), 'utf8')

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    path: '/repo/one',
    name: 'demo',
    kind: 'repo',
    added_at: '2026-08-14T00:00:00.000Z',
    ...overrides,
  }
}

function mrFixture(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 7,
    title: 'Fix the thing',
    author: 'octocat',
    sourceBranch: 'feat/mr-src',
    targetBranch: 'main',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/mr/7',
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

function branchFixture(overrides: Partial<LocalBranch> = {}): LocalBranch {
  return {
    name: 'feat/other',
    lastCommitRelative: '2 hours ago',
    subject: 'wip',
    isCurrent: false,
    worktreePath: null,
    ...overrides,
  }
}

function archiveFixture(overrides: Partial<ReviewArchiveSummary> = {}): ReviewArchiveSummary {
  return {
    ref: 'archive-1',
    branch: 'feat/mr-src',
    target: 'main',
    created_at: '2026-08-20T09:00:00.000Z',
    verdict: 'approve',
    mode: 'simple',
    findings_total: 0,
    ...overrides,
  }
}

/** Builds rows through the real row-building logic, never by hand. */
function rowsFrom(inputs: CodeReviewProjectInput[], running?: MrReviewStatus): CodeReviewRow[] {
  return buildCodeReviewRows({ projects: inputs, ...(running ? { running } : {}) })
}

function oneMrRow(overrides: Partial<ForgeMr> = {}, running?: MrReviewStatus): CodeReviewRow {
  const row = rowsFrom(
    [{ project: project(), mrs: [mrFixture(overrides)], branches: [], archives: [] }],
    running,
  )[0]
  if (!row) {
    throw new Error('expected exactly one row')
  }
  return row
}

function oneBranchRow(
  overrides: Partial<LocalBranch> = {},
  running?: MrReviewStatus,
): CodeReviewRow {
  const row = rowsFrom(
    [{ project: project(), mrs: [], branches: [branchFixture(overrides)], archives: [] }],
    running,
  )[0]
  if (!row) {
    throw new Error('expected exactly one row')
  }
  return row
}

type Props = {
  rows: readonly CodeReviewRow[]
  visibleRows: readonly CodeReviewRow[]
  query: string
  expanded: ReadonlySet<string>
  running: MrReviewStatus | null
  history: ReadonlyMap<string, readonly ReviewArchiveSummary[]>
  historyErrors: ReadonlyMap<string, string>
  selectedKey: string | null
}

function props(rows: readonly CodeReviewRow[], overrides: Partial<Props> = {}): Props {
  return {
    rows,
    visibleRows: rows,
    query: '',
    expanded: new Set(),
    running: null,
    history: new Map(),
    historyErrors: new Map(),
    selectedKey: null,
    ...overrides,
  }
}

async function render(p: Props): Promise<string> {
  const CodeReviewList = (await import('./CodeReviewList.vue')).default
  const app = createSSRApp(CodeReviewList, p)
  return renderToString(app)
}

describe('header: title and a count that reflects the full corpus, not the filtered one', () => {
  test('the title renders', async () => {
    const html = await render(props([]))
    expect(html).toContain(t('codeReview.title'))
  })

  test('the count is rows.length even while a search narrows visibleRows', async () => {
    const rows = rowsFrom([
      { project: project(), mrs: [mrFixture()], branches: [branchFixture()], archives: [] },
    ])
    const html = await render(props(rows, { visibleRows: [], query: 'nomatch' }))
    expect(html).toMatch(/class="crl-count">2</)
  })
})

describe('search: placeholder and the computed clear-button padding', () => {
  test('no query typed: no clear button, base padding (36px, 0 icons)', async () => {
    const html = await render(props([]))
    expect(html).toContain(t('codeReview.searchPlaceholder'))
    expect(html).not.toContain('crl-search-clear')
    expect(html).toContain('padding-right:36px')
  })

  test('a query present: the clear button renders, padding grows (56px, 1 icon)', async () => {
    const html = await render(props([], { query: 'x' }))
    expect(html).toContain('crl-search-clear')
    expect(html).toContain('padding-right:56px')
  })
})

describe('empty vs. search-empty: two distinct facts, never conflated', () => {
  test('no row at all: codeReview.empty, no rows rendered', async () => {
    const html = await render(props([]))
    expect(html).toContain(t('codeReview.empty'))
    expect(html).not.toContain(t('codeReview.searchEmpty'))
    expect(html).not.toContain('crl-row-wrap')
  })

  test('rows exist but the search narrows to none: codeReview.searchEmpty, not codeReview.empty', async () => {
    const rows = [oneMrRow()]
    const html = await render(props(rows, { visibleRows: [], query: 'nomatch' }))
    expect(html).toContain(t('codeReview.searchEmpty'))
    expect(html).not.toContain(t('codeReview.empty'))
    expect(html).not.toContain('crl-row-wrap')
  })

  test('rows exist and match: neither empty message renders', async () => {
    const html = await render(props([oneMrRow()]))
    expect(html).not.toContain(t('codeReview.empty'))
    expect(html).not.toContain(t('codeReview.searchEmpty'))
  })
})

describe('rows: one merge request and one branch, told apart', () => {
  test('an MR row shows its pastille, number and title', async () => {
    const html = await render(props([oneMrRow({ number: 7, title: 'Fix the thing' })]))
    expect(html).toContain('crl-mr-head')
    expect(html).not.toContain('crl-branch-head')
    expect(html).toContain('crl-mr-pastille--open')
    expect(html).toContain(t('mrs.number', { n: 7 }))
    expect(html).toContain(t('mrs.card.stateOpen'))
    expect(html).toContain('Fix the thing')
  })

  test('a branch row shows its icon and name, no MR pastille', async () => {
    const html = await render(props([oneBranchRow({ name: 'feat/lonely' })]))
    expect(html).toContain('crl-branch-head')
    expect(html).not.toContain('crl-mr-head')
    expect(html).toContain('feat/lonely')
  })

  test('one project with both an open MR and an unclaimed branch renders two rows', async () => {
    const rows = rowsFrom([
      {
        project: project(),
        mrs: [mrFixture({ sourceBranch: 'feat/mr-src' })],
        branches: [branchFixture({ name: 'feat/other' })],
        archives: [],
      },
    ])
    expect(rows).toHaveLength(2)
    const html = await render(props(rows))
    expect((html.match(/class="crl-row-wrap"/g) ?? []).length).toBe(2)
  })
})

describe('never reviewed: a neutral dash, never a fabricated color', () => {
  test('a row with no archived review shows the dash and its title, no verdict or running class', async () => {
    const html = await render(props([oneBranchRow()]))
    expect(html).toContain('crl-never')
    expect(html).toContain(t('codeReview.neverReviewed'))
    expect(html).not.toContain('crl-verdict--')
    expect(html).not.toContain('crl-badge--running')
  })
})

describe('a row currently under review', () => {
  test('shows the running badge instead of the dash', async () => {
    const running: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'p1',
      source: { kind: 'branch', name: 'feat/other' },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }
    const row = oneBranchRow({ name: 'feat/other' }, running)
    const html = await render(props([row], { running }))
    expect(html).toContain('crl-badge--running')
    expect(html).toContain(t('codeReview.running'))
    expect(html).not.toContain('crl-never')
  })

  test('a row with a past review that is running AGAIN shows the badge, not the old verdict', async () => {
    const running: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'p1',
      source: { kind: 'mr', number: 7 },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }
    const rows = rowsFrom(
      [
        {
          project: project(),
          mrs: [mrFixture({ number: 7, sourceBranch: 'feat/mr-src' })],
          branches: [],
          archives: [archiveFixture({ branch: 'feat/mr-src', verdict: 'request_changes' })],
        },
      ],
      running,
    )
    const html = await render(props(rows, { running }))
    expect(html).toContain('crl-badge--running')
    expect(html).not.toContain('crl-verdict--request_changes')
  })

  // The trap `project_id` exists to close: two projects can each have their
  // own "feat/other". isCodeReviewRowRunning must not confuse them.
  test('a same-named target running in a DIFFERENT project is not shown as running here', async () => {
    const runningElsewhere: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'project-OTHER',
      source: { kind: 'branch', name: 'feat/other' },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }
    const row = oneBranchRow({ name: 'feat/other' })
    const html = await render(props([row], { running: runningElsewhere }))
    expect(html).not.toContain('crl-badge--running')
    expect(html).toContain('crl-never')
  })

  // The case that matters most: sameReviewSource (useWorkspaceNav.ts) compares
  // only kind + number/name, no project_id — isCodeReviewRowRunning is what
  // ADDS that filter. Two projects can each have an open MR #7; only the one
  // named by running.project_id may show the badge.
  test('two projects with an open MR of the SAME NUMBER are never confused', async () => {
    const runningInA: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'project-A',
      source: { kind: 'mr', number: 7 },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }
    const rowA = rowsFrom([
      {
        project: project({ id: 'project-A' }),
        mrs: [mrFixture({ number: 7 })],
        branches: [],
        archives: [],
      },
    ])[0]
    const rowB = rowsFrom([
      {
        project: project({ id: 'project-B' }),
        mrs: [mrFixture({ number: 7 })],
        branches: [],
        archives: [],
      },
    ])[0]
    if (!rowA || !rowB) {
      throw new Error('expected one row per project')
    }

    const htmlA = await render(props([rowA], { running: runningInA }))
    expect(htmlA).toContain('crl-badge--running')

    const htmlB = await render(props([rowB], { running: runningInA }))
    expect(htmlB).not.toContain('crl-badge--running')
    expect(htmlB).toContain('crl-never')
  })
})

describe('verdict tints on the last-review badge', () => {
  test.each([
    ['approve', 'crl-verdict--approve'],
    ['request_changes', 'crl-verdict--request_changes'],
    ['comment', 'crl-verdict--comment'],
  ] as const)('verdict "%s" carries the %s class and its own age', async (verdict, cssClass) => {
    const rows = rowsFrom([
      {
        project: project(),
        mrs: [mrFixture({ sourceBranch: 'feat/mr-src' })],
        branches: [],
        archives: [
          archiveFixture({
            branch: 'feat/mr-src',
            verdict,
            created_at: '2026-08-19T00:00:00.000Z',
          }),
        ],
      },
    ])
    const html = await render(props(rows))
    expect(html).toContain(cssClass)
    expect(html).toContain(t(`verdict.${verdict}` as const))
    expect(html).toContain(formatRelativeAge('2026-08-19T00:00:00.000Z'))
  })
})

describe('expanded row: three history states, never confused (same trio as ReviewTargetPanel)', () => {
  test('neither map holds the key: the loading message', async () => {
    const row = oneBranchRow()
    const key = codeReviewRowKey(row)
    const html = await render(props([row], { expanded: new Set([key]) }))
    expect(html).toContain(t('codeReview.historyLoading'))
    expect(html).not.toContain(t('codeReview.historyEmpty'))
  })

  test('history holds an empty array for the key: the empty message, not loading', async () => {
    const row = oneBranchRow()
    const key = codeReviewRowKey(row)
    const html = await render(
      props([row], { expanded: new Set([key]), history: new Map([[key, []]]) }),
    )
    expect(html).toContain(t('codeReview.historyEmpty'))
    expect(html).not.toContain(t('codeReview.historyLoading'))
  })

  test('historyErrors holds the key: the error message, role=alert, regardless of history', async () => {
    const row = oneBranchRow()
    const key = codeReviewRowKey(row)
    const html = await render(
      props([row], {
        expanded: new Set([key]),
        historyErrors: new Map([[key, 'network down']]),
      }),
    )
    expect(html).toContain(t('codeReview.historyError'))
    expect(html).toContain('role="alert"')
    expect(html).not.toContain(t('codeReview.historyLoading'))
  })

  test('one archived entry: verdict, age, mode and finding count', async () => {
    const row = oneBranchRow()
    const key = codeReviewRowKey(row)
    const entry = archiveFixture({ mode: 'dual', findings_total: 3, verdict: 'approve' })
    const html = await render(
      props([row], { expanded: new Set([key]), history: new Map([[key, [entry]]]) }),
    )
    expect(html).toContain('crl-history-item')
    expect(html).toContain(t('verdict.approve'))
    expect(html).toContain(formatRelativeAge(entry.created_at))
    expect(html).toContain(t('codeReview.modeDual'))
    expect(html).toContain(t('workspace.findingsCount', { n: 3 }, 3))
  })

  test('collapsed: no panel renders at all, whatever the history maps hold', async () => {
    const row = oneBranchRow()
    const key = codeReviewRowKey(row)
    const html = await render(
      props([row], { expanded: new Set(), history: new Map([[key, [archiveFixture()]]]) }),
    )
    // Not a bare 'crl-panel' substring check: the chevron's aria-controls
    // value ("crl-panel-...") always contains it, expanded or not.
    expect(html).not.toContain('class="crl-panel"')
    expect(html).not.toContain('crl-history-item')
  })
})

describe('aria-expanded reflects the expanded set, both directions', () => {
  test('the key is in the set: aria-expanded="true", the collapse label, the panel renders', async () => {
    const row = oneBranchRow({ name: 'feat/aria' })
    const key = codeReviewRowKey(row)
    const html = await render(props([row], { expanded: new Set([key]) }))
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain(t('codeReview.collapseAria', { target: 'feat/aria' }))
    expect(html).toContain('class="crl-panel"')
  })

  test('the key is absent: aria-expanded="false", the expand label, no panel', async () => {
    const row = oneBranchRow({ name: 'feat/aria' })
    const html = await render(props([row], { expanded: new Set() }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain(t('codeReview.expandAria', { target: 'feat/aria' }))
    // Same care as the collapsed-history test: the panel ELEMENT, not the
    // substring the aria-controls attribute always carries.
    expect(html).not.toContain('class="crl-panel"')
  })
})

describe('selection: a tinted fill and aria-current, never a border', () => {
  test('the selected row carries the class and aria-current, the other row does not', async () => {
    const rowA = oneBranchRow({ name: 'feat/a' })
    const rowB = rowsFrom([
      {
        project: project({ id: 'p2' }),
        mrs: [],
        branches: [branchFixture({ name: 'feat/b' })],
        archives: [],
      },
    ])[0]
    if (!rowB) {
      throw new Error('expected a second row')
    }
    const html = await render(props([rowA, rowB], { selectedKey: codeReviewRowKey(rowA) }))
    const buttons = [...html.matchAll(/<button type="button" class="crl-select-btn[^"]*"([^>]*)>/g)]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.[0]).toContain('crl-select-btn--selected')
    expect(buttons[0]?.[1]).toContain('aria-current="true"')
    expect(buttons[1]?.[0]).not.toContain('crl-select-btn--selected')
    expect(buttons[1]?.[1]).not.toContain('aria-current')
  })

  test('the selected fill is a tint, not a border (doctrine, not decoration)', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.crl-select-btn--selected {'),
      SOURCE.indexOf('.crl-main {'),
    )
    expect(rule).toContain('background: var(--cs-green-soft);')
    expect(rule).not.toContain('border')
  })
})

describe('row order: exactly what buildCodeReviewRows produced, never re-sorted', () => {
  test('a running row, a reviewed row and a never-reviewed row keep the corpus order', async () => {
    const running: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'p1',
      source: { kind: 'branch', name: 'feat/running' },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }
    const rows = rowsFrom(
      [
        {
          project: project(),
          mrs: [],
          branches: [
            branchFixture({ name: 'feat/never' }),
            branchFixture({ name: 'feat/reviewed' }),
            branchFixture({ name: 'feat/running' }),
          ],
          archives: [
            archiveFixture({ branch: 'feat/reviewed', created_at: '2026-08-18T00:00:00.000Z' }),
          ],
        },
      ],
      running,
    )
    // buildCodeReviewRows' own tiering: running first, then the reviewed
    // branch, the never-reviewed one last — proven here so the assertion
    // below is pinned on a KNOWN order, not an assumed one.
    expect(rows.map((r) => (r.kind === 'branch' ? r.branch.name : ''))).toEqual([
      'feat/running',
      'feat/reviewed',
      'feat/never',
    ])

    const html = await render(props(rows, { running }))
    const positions = rows.map((row) => {
      const name = row.kind === 'branch' ? row.branch.name : ''
      const index = html.indexOf(`>${name}<`)
      expect(index).toBeGreaterThan(-1)
      return index
    })
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})

describe('source: each click wires the emit it should (SSR cannot click)', () => {
  test('the search input emits the raw value on every keystroke', () => {
    expect(SOURCE).toContain("emit('update:query', (event.target as HTMLInputElement).value)")
  })

  test('the clear button resets the query to empty', () => {
    expect(SOURCE).toContain("@click=\"emit('update:query', '')\"")
  })

  test('the chevron toggles its own row, by key', () => {
    expect(SOURCE).toContain('@click="emit(\'toggle-expanded\', entry.key)"')
  })

  test('the row button selects its own row', () => {
    expect(SOURCE).toContain('@click="emit(\'select\', entry.row)"')
  })

  test('a history item opens its own archive', () => {
    expect(SOURCE).toContain('@click="emit(\'open-archive\', entry.row, record.ref)"')
  })
})
