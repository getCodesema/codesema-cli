// Same harness as ForgeBoard.test.ts. A read of the raw source backs the
// handful of geometry assertions renderToString cannot see (scoped <style>
// rules never reach the SSR output, only inline style bindings do).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeMr } from '../../types'
import type { ForgeDetailItem } from './ForgeLogic'

const SOURCE = readFileSync(join(import.meta.dir, 'ForgeDetailPanel.vue'), 'utf8')

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

function htmlEscapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

async function render(item: ForgeDetailItem | null): Promise<string> {
  const ForgeDetailPanel = (await import('./ForgeDetailPanel.vue')).default
  const app = createSSRApp(ForgeDetailPanel, { item })
  return renderToString(app)
}

// This panel stays on screen at all times, not conditioned on a selection: a
// clean empty state replaces the "panel absent" behavior.
describe('no selection: a clean empty state, never an absent panel', () => {
  test('null renders the empty-state message, no columns', async () => {
    const html = await render(null)
    expect(html).toContain(t('forge.detailEmpty'))
    expect(html).not.toContain('fdp-columns')
  })

  test('a selection replaces the empty state entirely', async () => {
    const html = await render({
      kind: 'issue',
      issue: issue({ title: 'not empty any more' }),
    })
    expect(html).not.toContain(t('forge.detailEmpty'))
    expect(html).toContain('not empty any more')
  })
})

describe('the header', () => {
  test('is a labeled landmark for assistive tech', async () => {
    const html = await render({ kind: 'issue', issue: issue() })
    expect(html).toContain(htmlEscapeAttr(t('forge.detailTitle')))
  })

  test('the title never truncates, however long', async () => {
    const long = 'a title so long it would wrap across several lines of a 236px-wide rail '.repeat(
      4,
    )
    const html = await render({ kind: 'issue', issue: issue({ title: long }) })
    expect(html).toContain(long)
    // No line-clamp class from the list cards leaked in here.
    expect(html).not.toContain('fic-title')
    expect(html).not.toContain('mrc-title')
  })

  test('the number is a plain link, no badge or background class of its own', async () => {
    const html = await render({
      kind: 'issue',
      issue: issue({ number: 7, url: 'https://example.test/issues/7' }),
    })
    expect(html).toContain('class="fdp-number"')
    expect(html).toContain('href="https://example.test/issues/7"')
    expect(html).toContain(t('mrs.number', { n: 7 }))
  })

  test('the primary action opens the item in the forge, labeled and linked', async () => {
    const html = await render({
      kind: 'issue',
      issue: issue({ title: 'fix the thing', url: 'https://example.test/issues/9' }),
    })
    expect(html).toContain('href="https://example.test/issues/9"')
    expect(html).toContain(t('forge.detailOpenLabel'))
    expect(html).toContain(htmlEscapeAttr(t('forge.openItemAria', { title: 'fix the thing' })))
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('the secondary control closes the panel, labeled', async () => {
    const html = await render({ kind: 'issue', issue: issue() })
    expect(html).toContain(t('forge.detailClose'))
  })

  describe('state badges', () => {
    test('an open issue: green', async () => {
      const html = await render({ kind: 'issue', issue: issue({ state: 'open' }) })
      expect(html).toContain('fdp-state--open')
      expect(html).toContain(t('mrs.card.stateOpen'))
    })

    test('a closed issue: red (the contract only has two states)', async () => {
      const html = await render({ kind: 'issue', issue: issue({ state: 'closed' }) })
      expect(html).toContain('fdp-state--closed')
      expect(html).toContain(t('mrs.card.stateClosed'))
    })

    test('an open MR: green', async () => {
      const html = await render({ kind: 'mr', mr: mr({ state: 'open', isDraft: false }) })
      expect(html).toContain('fdp-state--open')
    })

    test('a draft MR: the muted neutral', async () => {
      const html = await render({ kind: 'mr', mr: mr({ state: 'open', isDraft: true }) })
      expect(html).toContain('fdp-state--draft')
    })

    test('a closed MR: red', async () => {
      const html = await render({ kind: 'mr', mr: mr({ state: 'closed' }) })
      expect(html).toContain('fdp-state--closed')
    })

    // Merged is lavender, deliberately never green: a merged MR whose checks
    // failed would otherwise show green for two contradictory reasons.
    test('a merged MR: lavender, never green', async () => {
      const html = await render({ kind: 'mr', mr: mr({ state: 'merged' }) })
      expect(html).toContain('fdp-state--merged')
      expect(html).toContain(t('mrs.card.stateMerged'))
    })

    test('an MR with no known state: the badge is absent, never a guessed one', async () => {
      const html = await render({ kind: 'mr', mr: mr({ state: null }) })
      expect(html).not.toContain('fdp-state--')
    })
  })
})

describe('the body', () => {
  test('markdown is rendered, not shown as raw sigils', async () => {
    const html = await render({
      kind: 'mr',
      mr: mr({ body: '**not bold** and a [link](https://example.test)' }),
    })
    expect(html).toContain('<strong>not bold</strong>')
    expect(html).toContain('href="https://example.test"')
    expect(html).not.toContain('**not bold**')
  })

  test('the rendered body sits in its own markdown container', async () => {
    const html = await render({ kind: 'issue', issue: issue({ body: 'steps to reproduce' }) })
    expect(html).toContain('class="fdp-md"')
  })

  test('a script tag in the body never reaches the page', async () => {
    const html = await render({
      kind: 'issue',
      issue: issue({ body: 'before <script>alert(1)</script> after' }),
    })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  test('an MR with no body: the empty state, not a blank paragraph', async () => {
    const html = await render({ kind: 'mr', mr: mr({ body: null }) })
    expect(html).toContain(t('forge.detailDescriptionEmpty'))
    expect(html).not.toContain('class="fdp-md"')
  })

  test('an issue with an empty string body (a real, description-less issue): the empty state', async () => {
    const html = await render({ kind: 'issue', issue: issue({ body: '' }) })
    expect(html).toContain(t('forge.detailDescriptionEmpty'))
  })

  test('an issue with a real body renders it', async () => {
    const html = await render({ kind: 'issue', issue: issue({ body: 'steps to reproduce' }) })
    expect(html).toContain('steps to reproduce')
    expect(html).not.toContain(t('forge.detailDescriptionEmpty'))
  })

  test('a #123 reference in the body becomes a link to the issue tracker', async () => {
    const html = await render({
      kind: 'issue',
      issue: issue({
        number: 42,
        url: 'https://github.com/acme/repo/issues/42',
        body: 'duplicate of #7',
      }),
    })
    expect(html).toContain('href="https://github.com/acme/repo/issues/7"')
    expect(html).toContain('fdp-md-ref')
  })
})

describe('layout geometry: the markdown container (read from source)', () => {
  test('a fenced code block scrolls in its own container, never the page', () => {
    expect(SOURCE).toMatch(/\.fdp-md pre \{[^}]*overflow-x: auto;/)
  })

  test('a reference link is dotted, a plain link is solid', () => {
    expect(SOURCE).toMatch(/\.fdp-md a \{[^}]*text-decoration-style: solid;/)
    expect(SOURCE).toMatch(/\.fdp-md a\.fdp-md-ref \{[^}]*text-decoration-style: dotted;/)
  })
})

describe('the metadata rail', () => {
  test('is a named region', async () => {
    const html = await render({ kind: 'issue', issue: issue() })
    expect(html).toContain('role="region"')
    expect(html).toContain(htmlEscapeAttr(t('forge.detailRailAria')))
  })

  test('an MR selection renders MrMetaRail (its auto-review section, always present)', async () => {
    const html = await render({ kind: 'mr', mr: mr() })
    expect(html).toContain('mrr-root')
    expect(html).toContain(t('mrs.rail.autoReview'))
  })

  describe('an issue selection: labels + dates only, MrMetaRail is not reused', () => {
    test('no MrMetaRail markup leaks in', async () => {
      const html = await render({ kind: 'issue', issue: issue() })
      expect(html).not.toContain('mrr-root')
    })

    test('labels: empty state when there are none', async () => {
      const html = await render({ kind: 'issue', issue: issue({ labels: [] }) })
      expect(html).toContain(t('mrs.rail.labels'))
      expect(html).toContain(t('mrs.rail.labelsEmpty'))
    })

    test('labels: every one renders when present', async () => {
      const html = await render({
        kind: 'issue',
        issue: issue({
          labels: [
            { name: 'bug', color: null },
            { name: 'ui', color: null },
          ],
        }),
      })
      expect(html).toContain('bug')
      expect(html).toContain('ui')
      expect(html).not.toContain(t('mrs.rail.labelsEmpty'))
    })

    test('dates: both opened and updated always render, createdAt/updatedAt are never null', async () => {
      const html = await render({
        kind: 'issue',
        issue: issue({
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        }),
      })
      expect(html).toContain(t('mrs.rail.dates'))
      expect(html).toContain(t('mrs.rail.openedAt', { age: t('time.daysAgo', { n: 2 }) }))
      expect(html).toContain(t('mrs.rail.updatedAt', { age: t('time.hoursAgo', { n: 1 }) }))
    })

    test('the last section (dates) carries no bottom rule', async () => {
      const html = await render({ kind: 'issue', issue: issue() })
      const sections = html.split('<section class="fdp-issue-rail-section">')
      const lastSection = sections[sections.length - 1] ?? ''
      expect(lastSection).toContain(t('mrs.rail.dates'))
    })
  })
})

describe('layout geometry (read from source: scoped CSS never reaches SSR output)', () => {
  test('the rail is fixed at 236px and never shrinks', () => {
    expect(SOURCE).toContain('flex: 0 0 236px;')
    expect(SOURCE).toContain('width: 236px;')
  })

  test('a 24px gap separates the two columns', () => {
    expect(SOURCE).toContain('gap: 24px;')
  })

  test('16px side padding, 20px vertical, on both columns', () => {
    expect(SOURCE).toMatch(/\.fdp-main,\s*\n\s*\.fdp-rail\s*\{/)
    expect(SOURCE).toContain('padding: 20px 16px;')
  })

  test('the stacking breakpoint reuses fb-shell, the same one the three panels already stack at', () => {
    const stackingQueries = SOURCE.match(/@container fb-shell \(max-width: \d+px\)/g) ?? []
    expect(stackingQueries).toHaveLength(1)
    expect(stackingQueries[0]).toBe('@container fb-shell (max-width: 640px)')
  })
})
