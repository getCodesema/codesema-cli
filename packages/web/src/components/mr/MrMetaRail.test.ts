// Same harness as MrCard.test.ts / WorkspaceHeader.test.ts.
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
    title: 'Add forge board',
    author: 'octocat',
    sourceBranch: 'feat/forge-board',
    targetBranch: 'main',
    updatedAt: '2026-08-20T10:00:00.000Z',
    url: 'https://example.test/mr/42',
    state: 'open',
    isDraft: false,
    labels: [{ name: 'ui', color: null }],
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

async function renderRail(mr: ForgeMr): Promise<string> {
  const MrMetaRail = (await import('./MrMetaRail.vue')).default
  const app = createSSRApp(MrMetaRail, { mr })
  return renderToString(app)
}

describe('labels section', () => {
  test('null hides the whole section', async () => {
    const html = await renderRail(baseMr({ labels: null }))
    expect(html).not.toContain(t('mrs.rail.labels'))
  })

  test('an empty list shows the empty state, not a blank section', async () => {
    const html = await renderRail(baseMr({ labels: [] }))
    expect(html).toContain(t('mrs.rail.labels'))
    expect(html).toContain(t('mrs.rail.labelsEmpty'))
  })

  test('a populated list renders every label', async () => {
    const html = await renderRail(
      baseMr({
        labels: [
          { name: 'ui', color: null },
          { name: 'backend', color: null },
        ],
      }),
    )
    expect(html).toContain('ui')
    expect(html).toContain('backend')
    expect(html).not.toContain(t('mrs.rail.labelsEmpty'))
  })

  test('a label color drives the pill fill, a null color falls back to the neutral token', async () => {
    const colored = await renderRail(baseMr({ labels: [{ name: 'bug', color: 'd73a4a' }] }))
    expect(colored).toContain('rgba(215, 58, 74, 0.16)')

    const neutral = await renderRail(baseMr({ labels: [{ name: 'bug', color: null }] }))
    expect(neutral).toContain('var(--cs-line-2)')
    expect(neutral).not.toContain('rgba(')
  })
})

describe('reviewers section', () => {
  test('null hides the whole section', async () => {
    const html = await renderRail(baseMr({ reviewers: null }))
    expect(html).not.toContain(t('mrs.rail.reviewers'))
  })

  test('an empty list shows the empty state', async () => {
    const html = await renderRail(baseMr({ reviewers: [] }))
    expect(html).toContain(t('mrs.rail.reviewersEmpty'))
  })

  test('a populated list renders every reviewer', async () => {
    const html = await renderRail(baseMr({ reviewers: ['alice', 'bob'] }))
    expect(html).toContain('alice')
    expect(html).toContain('bob')
  })
})

describe('assignees section', () => {
  test('null hides the whole section', async () => {
    const html = await renderRail(baseMr({ assignees: null }))
    expect(html).not.toContain(t('mrs.rail.assignees'))
  })

  test('an empty list shows the empty state', async () => {
    const html = await renderRail(baseMr({ assignees: [] }))
    expect(html).toContain(t('mrs.rail.assigneesEmpty'))
  })

  test('a populated list renders every assignee', async () => {
    const html = await renderRail(baseMr({ assignees: ['carol'] }))
    expect(html).toContain('carol')
  })
})

describe('milestone section', () => {
  test('null hides the section', async () => {
    const html = await renderRail(baseMr({ milestone: null }))
    expect(html).not.toContain(t('mrs.rail.milestone'))
  })

  test('a value renders', async () => {
    const html = await renderRail(baseMr({ milestone: 'v2.0' }))
    expect(html).toContain('v2.0')
  })
})

describe('mergeable section', () => {
  test('null hides the section', async () => {
    const html = await renderRail(baseMr({ mergeable: null }))
    expect(html).not.toContain(t('mrs.rail.mergeable'))
  })

  test.each([
    ['mergeable' as const, 'mrs.rail.mergeableStateOk' as const],
    ['conflicting' as const, 'mrs.rail.mergeableStateConflicting' as const],
    ['unknown' as const, 'mrs.rail.mergeableStateUnknown' as const],
  ])('%s renders its own distinct state', async (value, key) => {
    const html = await renderRail(baseMr({ mergeable: value }))
    expect(html).toContain(t(key))
  })
})

describe('commits section', () => {
  test('null hides the section', async () => {
    const html = await renderRail(baseMr({ commits: null }))
    expect(html).not.toContain(t('mrs.rail.commits'))
  })

  test('a measured zero renders, not silence', async () => {
    const html = await renderRail(baseMr({ commits: 0 }))
    expect(html).toContain(t('mrs.rail.commitsCount', { n: 0 }, 0))
  })

  test('a plural count renders', async () => {
    const html = await renderRail(baseMr({ commits: 5 }))
    expect(html).toContain(t('mrs.rail.commitsCount', { n: 5 }, 5))
  })
})

describe('auto-review: the section always renders, its four states are never confused', () => {
  test('checks null: "unavailable", never "no checks"', async () => {
    const html = await renderRail(baseMr({ checks: null }))
    expect(html).toContain(t('mrs.rail.autoReview'))
    expect(html).toContain(t('mrs.rail.autoReviewUnavailable'))
    expect(html).not.toContain(t('mrs.rail.autoReviewNone'))
  })

  test('checks present but every bucket at zero, not truncated: "no checks", never "unavailable"', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 0, failed: 0, pending: 0, skipped: 0, truncated: false } }),
    )
    expect(html).toContain(t('mrs.rail.autoReviewNone'))
    expect(html).not.toContain(t('mrs.rail.autoReviewUnavailable'))
  })

  test('checks present with real counts: passed collapses into one counter, failures and pending are spelled out', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 42, failed: 2, pending: 1, skipped: 0, truncated: false } }),
    )
    expect(html).toContain(t('mrs.checks.passed', { n: 42 }, 42))
    expect(html).toContain(t('mrs.checks.failed', { n: 2 }, 2))
    expect(html).toContain(t('mrs.checks.pending', { n: 1 }, 1))
    expect(html).not.toContain(t('mrs.checks.skipped', { n: 0 }, 0))
  })

  test('skipped checks are spelled out too when present', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 10, failed: 0, pending: 0, skipped: 3, truncated: false } }),
    )
    expect(html).toContain(t('mrs.checks.passed', { n: 10 }, 10))
    expect(html).toContain(t('mrs.checks.skipped', { n: 3 }, 3))
  })

  test('truncated falls back to an aggregate signal, never exact numbers', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 34, failed: 1, pending: 0, skipped: 0, truncated: true } }),
    )
    expect(html).toContain(t('mrs.checks.aggregateFailed'))
    expect(html).not.toContain('34')
    expect(html).not.toContain(t('mrs.checks.passed', { n: 34 }, 34))
  })
})
