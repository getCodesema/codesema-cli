// Harness mirrors WorkspaceHeader.test.ts: Bun's built-in `.vue` loader drops
// the template, so `vue/compiler-sfc` recompiles the SFC with the template
// inlined and `vue/server-renderer` renders it to a string. No DOM.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'

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

function baseMr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 42,
    title: 'Add issue radar',
    author: 'octocat',
    sourceBranch: 'feat/issue-radar',
    targetBranch: 'main',
    updatedAt: '2026-08-20T10:00:00.000Z',
    url: 'https://example.test/mr/42',
    state: 'open',
    isDraft: false,
    labels: ['ui'],
    additions: 120,
    deletions: 40,
    changedFiles: 6,
    checks: { passed: 12, failed: 1, pending: 2, skipped: 0, truncated: false },
    reviewers: ['reviewer-a'],
    assignees: ['assignee-a'],
    milestone: 'v1',
    mergeable: 'mergeable',
    commits: 4,
    body: 'A body',
    ...overrides,
  }
}

async function renderCard(mr: ForgeMr): Promise<string> {
  const MrCard = (await import('./MrCard.vue')).default
  const app = createSSRApp(MrCard, { mr })
  return renderToString(app)
}

describe('state badge', () => {
  test('open (not draft) renders the open badge', async () => {
    const html = await renderCard(baseMr({ state: 'open', isDraft: false }))
    expect(html).toContain(t('mrs.card.stateOpen'))
    expect(html).not.toContain(t('mrs.card.stateDraft'))
  })

  test('open + draft renders the draft badge instead of open', async () => {
    const html = await renderCard(baseMr({ state: 'open', isDraft: true }))
    expect(html).toContain(t('mrs.card.stateDraft'))
    expect(html).not.toContain(t('mrs.card.stateOpen'))
  })

  test('open with an unknown draft flag stays "open", never claims draft', async () => {
    const html = await renderCard(baseMr({ state: 'open', isDraft: null }))
    expect(html).toContain(t('mrs.card.stateOpen'))
    expect(html).not.toContain(t('mrs.card.stateDraft'))
  })

  test('merged renders the merged badge', async () => {
    const html = await renderCard(baseMr({ state: 'merged' }))
    expect(html).toContain(t('mrs.card.stateMerged'))
  })

  test('closed renders the closed badge', async () => {
    const html = await renderCard(baseMr({ state: 'closed' }))
    expect(html).toContain(t('mrs.card.stateClosed'))
  })

  test('a null state renders no badge at all', async () => {
    const html = await renderCard(baseMr({ state: null }))
    for (const key of [
      'mrs.card.stateOpen',
      'mrs.card.stateDraft',
      'mrs.card.stateMerged',
      'mrs.card.stateClosed',
    ] as const) {
      expect(html).not.toContain(t(key))
    }
  })
})

describe('diff stats: null hides, a measured zero shows', () => {
  test('additions and deletions both null hide the bar and both counters', async () => {
    const html = await renderCard(baseMr({ additions: null, deletions: null }))
    expect(html).not.toContain('mrc-diffblock')
    expect(html).not.toContain('+120')
    expect(html).not.toContain('−40')
  })

  test('a measured zero addition still renders "+0"', async () => {
    const html = await renderCard(baseMr({ additions: 0, deletions: 5 }))
    expect(html).toContain('+0')
  })

  test('additions null but deletions present shows the deletions counter alone, no bar', async () => {
    const html = await renderCard(baseMr({ additions: null, deletions: 7 }))
    expect(html).not.toContain('+120')
    expect(html).toContain('−7')
    expect(html).not.toContain('mrc-diffblock')
  })

  test('deletions null but additions present shows the additions counter alone, no bar', async () => {
    const html = await renderCard(baseMr({ additions: 9, deletions: null }))
    expect(html).toContain('+9')
    expect(html).not.toContain('mrc-diffblock')
  })

  test('both present renders the bar', async () => {
    const html = await renderCard(baseMr({ additions: 10, deletions: 10 }))
    expect(html).toContain('mrc-diffblock')
  })
})

describe('changed files: null hides, a measured zero shows', () => {
  test('null hides the counter entirely, never showing "0 file"', async () => {
    const html = await renderCard(baseMr({ changedFiles: null }))
    expect(html).not.toContain('file')
  })

  test('a measured zero renders', async () => {
    const html = await renderCard(baseMr({ changedFiles: 0 }))
    expect(html).toContain(t('mrs.card.filesChanged', { n: 0 }, 0))
  })

  test('a measured plural count renders', async () => {
    const html = await renderCard(baseMr({ changedFiles: 6 }))
    expect(html).toContain(t('mrs.card.filesChanged', { n: 6 }, 6))
  })
})

describe('checks tally', () => {
  test('null hides the whole tally', async () => {
    const html = await renderCard(baseMr({ checks: null }))
    expect(html).not.toContain(t('mrs.checks.passed', { n: 12 }, 12))
    expect(html).not.toContain(t('mrs.checks.aggregatePassed'))
  })

  test('renders the four buckets in fixed order, hiding the zero bucket', async () => {
    const html = await renderCard(
      baseMr({ checks: { passed: 12, failed: 1, pending: 2, skipped: 0, truncated: false } }),
    )
    const passedAt = html.indexOf(t('mrs.checks.passed', { n: 12 }, 12))
    const failedAt = html.indexOf(t('mrs.checks.failed', { n: 1 }, 1))
    const pendingAt = html.indexOf(t('mrs.checks.pending', { n: 2 }, 2))
    expect(passedAt).toBeGreaterThan(-1)
    expect(failedAt).toBeGreaterThan(passedAt)
    expect(pendingAt).toBeGreaterThan(failedAt)
    expect(html).not.toContain(t('mrs.checks.skipped', { n: 0 }, 0))
  })

  test('a bucket at a measured zero total (all zero) still shows nothing but is not confused with null', async () => {
    const html = await renderCard(
      baseMr({ checks: { passed: 0, failed: 0, pending: 0, skipped: 0, truncated: false } }),
    )
    expect(html).not.toContain(t('mrs.checks.passed', { n: 0 }, 0))
    expect(html).not.toContain(t('mrs.checks.failed', { n: 0 }, 0))
  })

  test('truncated falls back to an aggregate signal, never the exact numbers', async () => {
    const html = await renderCard(
      baseMr({ checks: { passed: 34, failed: 1, pending: 0, skipped: 0, truncated: true } }),
    )
    expect(html).toContain(t('mrs.checks.aggregateFailed'))
    expect(html).not.toContain('34')
    expect(html).not.toContain(t('mrs.checks.passed', { n: 34 }, 34))
  })
})
