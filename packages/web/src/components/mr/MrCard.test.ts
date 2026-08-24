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

// Pins each state's lucide glyph by its stable, library-generated class
// (lucide-<icon-name>), never the icon's own SVG path data, which can change
// on a library bump. "open" alone must render the plain pull-request glyph,
// not the draft one, since draft is a distinct state carried by `isDraft`.
describe('state glyph: one of the four pull-request icons, matching the variant', () => {
  test('open (not draft) renders the plain pull-request glyph', async () => {
    const html = await renderCard(baseMr({ state: 'open', isDraft: false }))
    expect(html).toContain('lucide-git-pull-request-icon')
    expect(html).not.toContain('lucide-git-pull-request-draft')
  })

  test('open + draft renders the draft glyph, not the plain one', async () => {
    const html = await renderCard(baseMr({ state: 'open', isDraft: true }))
    expect(html).toContain('lucide-git-pull-request-draft')
  })

  test('merged renders the git-merge glyph', async () => {
    const html = await renderCard(baseMr({ state: 'merged' }))
    expect(html).toContain('lucide-git-merge')
  })

  test('closed renders the closed pull-request glyph', async () => {
    const html = await renderCard(baseMr({ state: 'closed' }))
    expect(html).toContain('lucide-git-pull-request-closed')
  })

  test('the state icon stays decorative: aria-hidden, no separate accessible name of its own', async () => {
    const html = await renderCard(baseMr({ state: 'open', isDraft: false }))
    const stateAt = html.indexOf('mrc-state')
    const svgAt = html.indexOf('<svg', stateAt)
    expect(html.slice(svgAt, svgAt + 400)).toContain('aria-hidden="true"')
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

  test('a measured zero/zero hides the bar too: there is no neutral block to fall back to', async () => {
    const html = await renderCard(baseMr({ additions: 0, deletions: 0 }))
    expect(html).not.toContain('mrc-diffblock')
    expect(html).toContain('+0')
    expect(html).toContain('−0')
  })
})

describe('stats row: omitted entirely with neither diff nor checks, files come before the bar', () => {
  test('omitted entirely when there is neither diff data nor checks', async () => {
    const html = await renderCard(
      baseMr({ additions: null, deletions: null, changedFiles: null, checks: null }),
    )
    expect(html).not.toContain('mrc-stats')
  })

  test('present as soon as any one of diff/files/checks is present', async () => {
    const html = await renderCard(
      baseMr({ additions: null, deletions: null, changedFiles: null, checks: null }),
    )
    const withFilesOnly = await renderCard(
      baseMr({ additions: null, deletions: null, changedFiles: 3, checks: null }),
    )
    expect(html).not.toContain('mrc-stats')
    expect(withFilesOnly).toContain('mrc-stats')
  })

  test('the file count renders before the diff bar in the markup', async () => {
    const html = await renderCard(baseMr({ additions: 10, deletions: 10, changedFiles: 6 }))
    expect(html.indexOf('mrc-files')).toBeLessThan(html.indexOf('mrc-diffbar'))
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

  test('carries the file-diff glyph, by its stable lucide class', async () => {
    const html = await renderCard(baseMr({ changedFiles: 6 }))
    expect(html).toContain('lucide-file-diff')
  })
})

describe('checks tally', () => {
  test('null hides the whole tally', async () => {
    const html = await renderCard(baseMr({ checks: null }))
    expect(html).not.toContain(t('mrs.checks.passed', { n: 12 }, 12))
    expect(html).not.toContain(t('mrs.checks.aggregatePassed'))
  })

  test('renders the four buckets in fixed order (failed, pending, passed, skipped), hiding the zero bucket', async () => {
    const html = await renderCard(
      baseMr({ checks: { passed: 12, failed: 1, pending: 2, skipped: 0, truncated: false } }),
    )
    const failedAt = html.indexOf(t('mrs.checks.failed', { n: 1 }, 1))
    const pendingAt = html.indexOf(t('mrs.checks.pending', { n: 2 }, 2))
    const passedAt = html.indexOf(t('mrs.checks.passed', { n: 12 }, 12))
    expect(failedAt).toBeGreaterThan(-1)
    expect(pendingAt).toBeGreaterThan(failedAt)
    expect(passedAt).toBeGreaterThan(pendingAt)
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

  test('each visible bucket carries its own full label for assistive tech, not just the bare digit', async () => {
    const html = await renderCard(
      baseMr({ checks: { passed: 12, failed: 1, pending: 2, skipped: 0, truncated: false } }),
    )
    expect(html).toContain(t('mrs.checks.failed', { n: 1 }, 1))
  })

  // Pins each bucket's lucide glyph by its stable, library-generated class,
  // never the icon's own SVG path data.
  test('each bucket renders its own distinct glyph', async () => {
    const html = await renderCard(
      baseMr({ checks: { passed: 12, failed: 1, pending: 2, skipped: 3, truncated: false } }),
    )
    expect(html).toContain('lucide-circle-x')
    expect(html).toContain('lucide-loader-circle')
    expect(html).toContain('lucide-circle-check')
    expect(html).toContain('lucide-circle-slash')
  })
})

test('the age reads through the shared relative-time formatter', async () => {
  const html = await renderCard(baseMr({ updatedAt: new Date().toISOString() }))
  expect(html).toContain(t('time.justNow'))
})
