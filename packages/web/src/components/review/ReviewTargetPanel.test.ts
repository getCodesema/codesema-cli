// SSR-only harness (no DOM, no click simulation), same convention as
// rail/RepositoriesList.test.ts and changes/ChangedFileDiff.test.ts: the
// three action-band buttons never fire in a renderToString pass, so which
// EVENT each one emits is pinned on the raw source below instead, while
// which BUTTON renders in which runStatus is exercised through real props.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeMr, MrReviewStatus, ReviewArchiveSummary } from '../../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'ReviewTargetPanel.vue'), 'utf8')

function mrFixture(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 7,
    title: 'Fix the thing',
    author: 'octocat',
    sourceBranch: 'feat/x',
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

type Props = {
  projectId: string
  projectName: string
  target: { kind: 'mr'; mr: ForgeMr } | { kind: 'branch'; name: string }
  history: ReviewArchiveSummary[] | null
  historyError: string | null
  runStatus: MrReviewStatus | null
  starting: boolean
  startError: string | null
}

function mrProps(overrides: Partial<Props> = {}): Props {
  const mr = mrFixture()
  return {
    projectId: 'p1',
    projectName: 'demo',
    target: { kind: 'mr', mr },
    history: [],
    historyError: null,
    runStatus: { available: true, phase: 'idle' },
    starting: false,
    startError: null,
    ...overrides,
  }
}

function branchProps(overrides: Partial<Props> = {}): Props {
  return {
    projectId: 'p1',
    projectName: 'demo',
    target: { kind: 'branch', name: 'feat/x' },
    history: [],
    historyError: null,
    runStatus: { available: true, phase: 'idle' },
    starting: false,
    startError: null,
    ...overrides,
  }
}

// ForgeDetailPanel never touches $t; PreviewPanel's own template does, and is
// mounted for a branch target, so it must be wired here too, same as the
// real app does (see main.ts) — a bare createSSRApp does not have it.
async function render(props: Props): Promise<string> {
  const ReviewTargetPanel = (await import('./ReviewTargetPanel.vue')).default
  const app = createSSRApp(ReviewTargetPanel, props)
  app.config.globalProperties.$t = t
  return renderToString(app)
}

describe('action band: no review running', () => {
  test('renders both launch buttons, and neither the live nor the busy state', async () => {
    const html = await render(mrProps())
    expect(html).toContain(t('codeReview.runDual'))
    expect(html).not.toContain('rtp-run--live')
    expect(html).not.toContain(t('codeReview.busyElsewhere'))
  })

  test('a null runStatus (not yet read) also reads as no review running', async () => {
    const html = await render(mrProps({ runStatus: null }))
    expect(html).toContain(t('codeReview.runDual'))
    expect(html).not.toContain('rtp-run--live')
  })
})

describe('action band: a review is running on this exact target', () => {
  test('renders the single live button', async () => {
    const html = await render(
      mrProps({
        runStatus: {
          available: true,
          phase: 'running',
          project_id: 'p1',
          source: { kind: 'mr', number: 7 },
          mode: 'simple',
          started_at: '2026-08-20T09:00:00.000Z',
        },
      }),
    )
    expect(html).toContain('rtp-run--live')
    expect(html).toContain(t('codeReview.running'))
    expect(html).not.toContain(t('codeReview.busyElsewhere'))
  })
})

describe('action band: a review is running elsewhere', () => {
  test('a different target in the same project reads as busy elsewhere', async () => {
    const html = await render(
      mrProps({
        runStatus: {
          available: true,
          phase: 'running',
          project_id: 'p1',
          source: { kind: 'mr', number: 99 },
          mode: 'simple',
          started_at: '2026-08-20T09:00:00.000Z',
        },
      }),
    )
    expect(html).toContain(t('codeReview.busyElsewhere'))
    expect(html).not.toContain('rtp-run--live')
  })

  // The trap the project_id field exists to close: two projects can each
  // have their own MR #7. Matching by source alone would wrongly call the
  // second project's panel "running here" just because the numbers agree.
  test('two projects with the same MR number are never confused', async () => {
    const runningInProjectA: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'project-A',
      source: { kind: 'mr', number: 7 },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }

    const ownPanel = await render(
      mrProps({
        projectId: 'project-A',
        target: { kind: 'mr', mr: mrFixture({ number: 7 }) },
        runStatus: runningInProjectA,
      }),
    )
    expect(ownPanel).toContain('rtp-run--live')
    expect(ownPanel).not.toContain(t('codeReview.busyElsewhere'))

    const otherProjectSameNumber = await render(
      mrProps({
        projectId: 'project-B',
        target: { kind: 'mr', mr: mrFixture({ number: 7 }) },
        runStatus: runningInProjectA,
      }),
    )
    expect(otherProjectSameNumber).not.toContain('rtp-run--live')
    expect(otherProjectSameNumber).toContain(t('codeReview.busyElsewhere'))
  })

  // Same trap, branch source: two projects can each have a "feat/shared".
  test('two projects with the same branch name are never confused', async () => {
    const runningInProjectA: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'project-A',
      source: { kind: 'branch', name: 'feat/shared' },
      mode: 'simple',
      started_at: '2026-08-20T09:00:00.000Z',
    }

    const ownPanel = await render(
      branchProps({
        projectId: 'project-A',
        target: { kind: 'branch', name: 'feat/shared' },
        runStatus: runningInProjectA,
      }),
    )
    expect(ownPanel).toContain('rtp-run--live')
    expect(ownPanel).not.toContain(t('codeReview.busyElsewhere'))

    const otherProjectSameBranch = await render(
      branchProps({
        projectId: 'project-B',
        target: { kind: 'branch', name: 'feat/shared' },
        runStatus: runningInProjectA,
      }),
    )
    expect(otherProjectSameBranch).not.toContain('rtp-run--live')
    expect(otherProjectSameBranch).toContain(t('codeReview.busyElsewhere'))
  })
})

describe('source: each action-band button emits the event it should (SSR cannot click)', () => {
  const actionsBlock = SOURCE.split('<div class="rtp-actions">')[1]?.split('</div>')[0] ?? ''

  test('the actions band was actually found in the source', () => {
    expect(actionsBlock).not.toBe('')
  })

  test('the live (running-here) button emits open-running', () => {
    const liveBranch = actionsBlock.split('v-if="runningHere"')[1]?.split('</template>')[0] ?? ''
    expect(liveBranch).toContain('rtp-run--live')
    expect(liveBranch).toContain("emit('open-running')")
  })

  test('the busy-elsewhere button also emits open-running', () => {
    const elsewhereBranch =
      actionsBlock.split('v-else-if="running"')[1]?.split('</template>')[0] ?? ''
    expect(elsewhereBranch).toContain('codeReview.busyElsewhere')
    expect(elsewhereBranch).toContain("emit('open-running')")
  })

  test('the idle buttons emit run with their own mode', () => {
    const idleBranch = actionsBlock.split('<template v-else>')[1] ?? ''
    expect(idleBranch).toContain("emit('run', 'simple')")
    expect(idleBranch).toContain("emit('run', 'dual')")
  })
})

describe('history: three states, never confused', () => {
  test('history === null (not yet read) shows the loading message, not "empty"', async () => {
    const html = await render(mrProps({ history: null }))
    expect(html).toContain(t('codeReview.historyLoading'))
    expect(html).not.toContain(t('codeReview.historyEmpty'))
  })

  test('an empty array shows the empty message, not "loading"', async () => {
    const html = await render(mrProps({ history: [] }))
    expect(html).toContain(t('codeReview.historyEmpty'))
    expect(html).not.toContain(t('codeReview.historyLoading'))
  })

  test('historyError takes over the section, regardless of history', async () => {
    const html = await render(mrProps({ history: null, historyError: 'network down' }))
    expect(html).toContain(t('codeReview.historyError'))
    expect(html).toContain('role="alert"')
    expect(html).not.toContain(t('codeReview.historyLoading'))
  })
})

describe('history: one archived entry', () => {
  test('shows its verdict, age, mode and finding count', async () => {
    const entry: ReviewArchiveSummary = {
      ref: 'archive-1',
      branch: 'feat/x',
      target: 'main',
      created_at: '2026-08-20T09:00:00.000Z',
      verdict: 'approve',
      mode: 'dual',
      findings_total: 3,
    }
    const html = await render(mrProps({ history: [entry] }))
    expect(html).toContain(t('verdict.approve'))
    expect(html).toContain(formatRelativeAge(entry.created_at))
    expect(html).toContain(t('codeReview.modeDual'))
    expect(html).toContain(t('workspace.findingsCount', { n: 3 }, 3))
  })

  test.each([
    ['approve', 'rtp-verdict--approve'],
    ['request_changes', 'rtp-verdict--request_changes'],
    ['comment', 'rtp-verdict--comment'],
  ] as const)('verdict "%s" carries the %s tint class', async (verdict, cssClass) => {
    const entry: ReviewArchiveSummary = {
      ref: 'archive-1',
      branch: 'feat/x',
      target: 'main',
      created_at: '2026-08-20T09:00:00.000Z',
      verdict,
      mode: 'simple',
      findings_total: 0,
    }
    const html = await render(mrProps({ history: [entry] }))
    expect(html).toContain(cssClass)
  })
})

describe('body: the right detail panel for the target kind', () => {
  test('an MR target mounts ForgeDetailPanel, not PreviewPanel', async () => {
    const html = await render(mrProps())
    expect(html).toContain('fdp-root')
    expect(html).not.toContain('pv-root')
  })

  test('a branch target mounts PreviewPanel, not ForgeDetailPanel', async () => {
    const html = await render(branchProps())
    expect(html).toContain('pv-root')
    expect(html).not.toContain('fdp-root')
  })
})

describe('the branch-target hint', () => {
  test('shown for a branch target', async () => {
    const html = await render(branchProps())
    expect(html).toContain(t('codeReview.branchTargetHint'))
  })

  test('absent for an MR target', async () => {
    const html = await render(mrProps())
    expect(html).not.toContain(t('codeReview.branchTargetHint'))
  })
})

describe('a launch error', () => {
  test('renders with role="alert"', async () => {
    const html = await render(mrProps({ startError: 'could not start the review' }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('could not start the review')
  })
})
