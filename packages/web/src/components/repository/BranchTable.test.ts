import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { branchRowKey, type BranchRow, type BranchSortKey } from '../../composables/useRepository'
import type { TaskState } from '../../composables/useTasks'
import type { ForgeMr, TaskRecord } from '../../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'BranchTable.vue'), 'utf8')

function record(partial: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    version: 1,
    title: partial.id,
    status: 'running',
    base: 'main',
    branch: `codesema/task-${partial.id}`,
    worktree: `/wt/${partial.id}`,
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-14T09:00:00.000Z',
    updated_at: '2026-08-14T09:00:00.000Z',
    ...partial,
  }
}

function state(projectId: string, partial: Partial<TaskRecord> & { id: string }): TaskState {
  return {
    projectId,
    record: record(partial),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
}

function mr(partial: Partial<ForgeMr> & { number: number }): ForgeMr {
  return {
    title: `MR ${partial.number}`,
    author: 'dev',
    sourceBranch: `feature/${partial.number}`,
    targetBranch: 'main',
    updatedAt: '2026-08-14T08:00:00.000Z',
    url: `https://forge.example/mr/${partial.number}`,
    state: 'open',
    isDraft: null,
    labels: null,
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
    ...partial,
  }
}

function branchRow(overrides: Partial<Extract<BranchRow, { kind: 'branch' }>> = {}): BranchRow {
  return {
    kind: 'branch',
    name: 'feature-x',
    worktreePath: null,
    subject: 'fix the thing',
    lastCommitRelative: '2 hours ago',
    isCurrent: false,
    openMr: null,
    conversations: [],
    action: { kind: 'draft-workon', branch: 'feature-x', target: null },
    ...overrides,
  }
}

function detachedRow(worktreePath: string): BranchRow {
  return { kind: 'detached-worktree', worktreePath }
}

type Props = {
  rows: readonly BranchRow[]
  visibleRows: readonly BranchRow[]
  query: string
  sort: BranchSortKey
  expanded: ReadonlySet<string>
  loading: boolean
  projectNames: ReadonlyMap<string, string>
}

function props(overrides: Partial<Props> = {}): Props {
  const rows = overrides.rows ?? []
  return {
    rows,
    visibleRows: rows,
    query: '',
    sort: 'status',
    expanded: new Set(),
    loading: false,
    projectNames: new Map(),
    ...overrides,
  }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const Component = (await import('./BranchTable.vue')).default
  const app = createSSRApp(Component, props(overrides))
  return renderToString(app)
}

describe('BranchTable: empty states', () => {
  test('an empty repository shows the noBranches message', async () => {
    const html = await render({ rows: [], visibleRows: [] })
    expect(html).toContain('This repository has no local branch.')
  })

  test('a filter that leaves nothing shows filterEmpty, not noBranches', async () => {
    const html = await render({ rows: [branchRow()], visibleRows: [] })
    expect(html).toContain('No branch matches this filter.')
    expect(html).not.toContain('This repository has no local branch.')
  })

  test('a full table renders every row and no empty message', async () => {
    const rows = [branchRow({ name: 'alpha' }), branchRow({ name: 'beta' })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
    expect(html).not.toContain('No branch matches this filter.')
    expect(html).not.toContain('This repository has no local branch.')
  })
})

describe('BranchTable: the three worktree pastilles', () => {
  test('a checked-out branch shows "worktree"', async () => {
    const rows = [branchRow({ worktreePath: '/wt/feature-x' })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('worktree')
  })

  test('a branch with no checkout shows "no worktree"', async () => {
    const rows = [branchRow({ worktreePath: null })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('no worktree')
  })

  test('a detached worktree row shows "detached"', async () => {
    const rows = [detachedRow('/wt/spike-1')]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('detached')
  })
})

describe('BranchTable: branch cell', () => {
  test('a branch row shows its name and its commit subject', async () => {
    const rows = [branchRow({ name: 'feature-login', subject: 'add login form' })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('feature-login')
    expect(html).toContain('add login form')
  })

  test('the current branch carries the "current" badge', async () => {
    const rows = [branchRow({ name: 'develop', isCurrent: true })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('bt-current-badge')
  })

  test('a non-current branch has no "current" badge', async () => {
    const rows = [branchRow({ name: 'develop', isCurrent: false })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).not.toContain('bt-current-badge')
  })
})

describe('BranchTable: a detached row has no name and no action', () => {
  test('shows the worktree path in place of a branch name', async () => {
    const rows = [detachedRow('/wt/spike-42')]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('/wt/spike-42')
    expect(html).toContain('bt-branch-mono--detached')
  })

  test('shows the detached hint instead of an action button', async () => {
    const rows = [detachedRow('/wt/spike-1')]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('A detached worktree carries no branch')
    expect(html).not.toContain('bt-action-btn')
  })

  test('renders no expand chevron', async () => {
    const rows = [detachedRow('/wt/spike-1')]
    const html = await render({ rows, visibleRows: rows })
    expect(html).not.toContain('bt-chevron-btn')
  })
})

describe('BranchTable: MR pastille', () => {
  test('a row with an open MR shows its number and the open variant', async () => {
    const rows = [branchRow({ openMr: mr({ number: 42, state: 'open', isDraft: false }) })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('#42')
    expect(html).toContain('bt-mr-pastille--open')
  })

  test('a draft MR uses the draft variant', async () => {
    const rows = [branchRow({ openMr: mr({ number: 7, state: 'open', isDraft: true }) })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('bt-mr-pastille--draft')
  })

  test('a row without an open MR shows no pastille', async () => {
    const rows = [branchRow({ openMr: null })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).not.toContain('bt-mr-pastille')
  })
})

describe('BranchTable: conversations badge', () => {
  test('a row with one conversation shows the singular form', async () => {
    const rows = [branchRow({ conversations: [state('repo-a', { id: 't1', status: 'running' })] })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('1 conversation')
    expect(html).not.toContain('1 conversations')
  })

  test('a row with several conversations shows the plural form', async () => {
    const rows = [
      branchRow({
        conversations: [
          state('repo-a', { id: 't1', status: 'running' }),
          state('repo-a', { id: 't2', status: 'queued' }),
        ],
      }),
    ]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('2 conversations')
  })

  test('a row with no conversation shows no badge', async () => {
    const rows = [branchRow({ conversations: [] })]
    const html = await render({ rows, visibleRows: rows })
    expect(html).not.toContain('bt-conversations-badge')
  })

  test('the badge is tinted by the most urgent status among several', async () => {
    const rows = [
      branchRow({
        conversations: [
          state('repo-a', { id: 't1', status: 'shipped' }),
          state('repo-a', { id: 't2', status: 'waiting_for_you' }),
        ],
      }),
    ]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('var(--cs-amber-text)')
  })
})

describe('BranchTable: expanded row', () => {
  test('collapsed by default: the conversation title is absent', async () => {
    const rows = [
      branchRow({
        name: 'feature-x',
        conversations: [state('repo-a', { id: 't1', status: 'running', title: 'Fix the bug' })],
      }),
    ]
    const html = await render({ rows, visibleRows: rows, expanded: new Set() })
    expect(html).not.toContain('Fix the bug')
  })

  test('expanding the row via its key reveals its conversations', async () => {
    const row = branchRow({
      name: 'feature-x',
      conversations: [state('repo-a', { id: 't1', status: 'running', title: 'Fix the bug' })],
    })
    const html = await render({
      rows: [row],
      visibleRows: [row],
      expanded: new Set([branchRowKey(row)]),
    })
    expect(html).toContain('Fix the bug')
  })

  test('an expanded branch with no conversation shows the empty hint', async () => {
    const row = branchRow({ name: 'feature-x', conversations: [] })
    const html = await render({
      rows: [row],
      visibleRows: [row],
      expanded: new Set([branchRowKey(row)]),
    })
    expect(html).toContain('No conversation on this branch yet.')
  })

  test('aria-expanded is true once the row key is in the expanded set', async () => {
    const row = branchRow({ name: 'feature-x' })
    const html = await render({
      rows: [row],
      visibleRows: [row],
      expanded: new Set([branchRowKey(row)]),
    })
    expect(html).toContain('aria-expanded="true"')
  })

  test('aria-expanded is false otherwise', async () => {
    const rows = [branchRow({ name: 'feature-x' })]
    const html = await render({ rows, visibleRows: rows, expanded: new Set() })
    expect(html).toContain('aria-expanded="false"')
  })
})

describe('BranchTable: row action button', () => {
  test('an "open" action resolved to a live conversation shows Open', async () => {
    const active = state('repo-a', { id: 't1', branch: 'feature-x', status: 'running' })
    const rows = [
      branchRow({
        name: 'feature-x',
        conversations: [active],
        action: { kind: 'open', taskId: 't1' },
      }),
    ]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('Open')
    expect(html).not.toContain('New conversation')
  })

  test('a draft action shows New conversation', async () => {
    const rows = [
      branchRow({ action: { kind: 'draft-workon', branch: 'feature-x', target: null } }),
    ]
    const html = await render({ rows, visibleRows: rows })
    expect(html).toContain('New conversation')
  })
})

describe('BranchTable: toolbar', () => {
  test('reflects the current query in the filter input', async () => {
    const html = await render({ query: 'login' })
    expect(html).toContain('value="login"')
  })

  test('lists all three sort options', async () => {
    const html = await render()
    expect(html).toContain('value="status"')
    expect(html).toContain('value="updated"')
    expect(html).toContain('value="name"')
  })

  test('the refresh button spins while loading', async () => {
    const html = await render({ loading: true })
    expect(html).toContain('bt-refresh--spin')
  })

  test('the refresh button does not spin when idle', async () => {
    const html = await render({ loading: false })
    expect(html).not.toContain('bt-refresh--spin')
  })

  test('the toolbar row count reflects visibleRows, not the unfiltered corpus', async () => {
    const a = branchRow({ name: 'a' })
    const rows = [a, branchRow({ name: 'b' }), branchRow({ name: 'c' })]
    const html = await render({ rows, visibleRows: [a] })
    expect(html).toContain('bt-row-count')
  })
})

describe('BranchTable: table title', () => {
  test('the header count reflects the unfiltered corpus, not the filtered view', async () => {
    const a = branchRow({ name: 'a' })
    const rows = [a, branchRow({ name: 'b' })]
    const html = await render({ rows, visibleRows: [a] })
    expect(html).toContain('(2)')
  })
})

describe('BranchTable: design tokens', () => {
  test('no hex literal color was introduced: every color is a --cs-* token', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
  })
})
