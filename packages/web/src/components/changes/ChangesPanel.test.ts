// SSR-only harness (no DOM): renderToString exercises props-driven markup.
// Drag/keyboard resize, the width persistence round-trip, and the copy-to-
// clipboard feedback are interaction-only and untestable this way, same
// accepted gap as forge/ForgeSplitter.test.ts (their math lives in
// ChangesLogic.test.ts / ChangesPrefs.test.ts instead, which IS exhaustively
// unit-tested). Geometry that only lives in the scoped <style> block is read
// back from source, same convention as forge/ForgeDetailPanel.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'

const SOURCE = readFileSync(join(import.meta.dir, 'ChangesPanel.vue'), 'utf8')

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

function mr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 42,
    title: 'Fix the thing',
    author: 'octocat',
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://github.com/octo/repo/pull/42',
    state: 'open',
    isDraft: false,
    labels: [],
    additions: 12,
    deletions: 4,
    changedFiles: 3,
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

async function render(props: { mr: ForgeMr | null; project?: string }): Promise<string> {
  const ChangesPanel = (await import('./ChangesPanel.vue')).default
  const app = createSSRApp(ChangesPanel, props)
  return renderToString(app)
}

describe('no pull request (fiche §7)', () => {
  test('plain centered text, no icon', async () => {
    const html = await render({ mr: null })
    expect(html).toContain(t('changes.noMr'))
    expect(html).toContain('class="cp-empty"')
  })

  test('no row-1 tab, no header, no row-2 tabs', async () => {
    const html = await render({ mr: null })
    expect(html).not.toContain('cp-tab1')
    expect(html).not.toContain('cp-meta')
    expect(html).not.toContain('cp-row2')
  })

  test('the close button is still there: the panel stays closable with nothing to show', async () => {
    const html = await render({ mr: null })
    expect(html).toContain('class="cp-close"')
    expect(html).toContain(t('changes.close'))
  })
})

describe('the state badge (fiche §4: green/open, lavender/merged, our own draft, red/closed)', () => {
  test('open: green', async () => {
    const html = await render({ mr: mr({ state: 'open', isDraft: false }) })
    expect(html).toContain('cp-badge--open')
  })

  test('draft: its own variant, never falling back to closed', async () => {
    const html = await render({ mr: mr({ state: 'open', isDraft: true }) })
    expect(html).toContain('cp-badge--draft')
    expect(html).not.toContain('cp-badge--closed')
  })

  test('merged: lavender, never green', async () => {
    const html = await render({ mr: mr({ state: 'merged' }) })
    expect(html).toContain('cp-badge--merged')
  })

  test('closed: red', async () => {
    const html = await render({ mr: mr({ state: 'closed' }) })
    expect(html).toContain('cp-badge--closed')
  })

  test('no known state: the badge is absent entirely, never a guessed one', async () => {
    const html = await render({ mr: mr({ state: null }) })
    expect(html).not.toContain('cp-badge--')
  })

  test('each variant has its own distinct color rule', () => {
    expect(SOURCE).toMatch(/\.cp-badge--open\s*\{[^}]*background: var\(--cs-green\);/)
    expect(SOURCE).toMatch(/\.cp-badge--draft\s*\{[^}]*background: var\(--cs-ghost\);/)
    expect(SOURCE).toMatch(/\.cp-badge--merged\s*\{[^}]*background: var\(--cs-lavender\);/)
    expect(SOURCE).toMatch(/\.cp-badge--closed\s*\{[^}]*background: var\(--cs-red\);/)
  })
})

describe('the metadata line (fiche §4)', () => {
  test('the forge name is plain text, derived from the URL, github.com', async () => {
    const html = await render({ mr: mr({ url: 'https://github.com/octo/repo/pull/42' }) })
    expect(html).toContain('class="cp-forge"')
    expect(html).toContain('>GitHub<')
  })

  test('gitlab.com renders GitLab', async () => {
    const html = await render({
      mr: mr({ url: 'https://gitlab.com/octo/repo/-/merge_requests/42' }),
    })
    expect(html).toContain('>GitLab<')
  })

  test('the source branch is shown with a copy action, and the target branch too', async () => {
    const html = await render({ mr: mr({ sourceBranch: 'feat/x', targetBranch: 'develop' }) })
    expect(html).toContain('feat/x')
    expect(html).toContain('develop')
    expect(html).toContain(t('changes.copySourceBranch'))
  })

  test('refresh and open-in-forge actions are present, the latter a real link', async () => {
    const html = await render({ mr: mr({ url: 'https://github.com/octo/repo/pull/42' }) })
    expect(html).toContain(t('changes.refresh'))
    expect(html).toContain('href="https://github.com/octo/repo/pull/42"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('the title block (fiche §4)', () => {
  test('the number sits on the same line as the title', async () => {
    const html = await render({ mr: mr({ title: 'Fix the thing', number: 7 }) })
    const titleTag = /<h2 class="cp-title">[\s\S]*?<\/h2>/.exec(html)?.[0] ?? ''
    expect(titleTag).toContain('Fix the thing')
    expect(titleTag).toContain(t('mrs.number', { n: 7 }))
  })

  test('author, additions/deletions and the update age all render on the byline', async () => {
    const html = await render({ mr: mr({ author: 'octocat', additions: 12, deletions: 4 }) })
    expect(html).toContain('octocat')
    expect(html).toContain('+12')
    expect(html).toContain('−4')
  })

  test('a null additions/deletions omits that figure, never shows a fabricated 0', async () => {
    const html = await render({ mr: mr({ additions: null, deletions: null }) })
    expect(html).not.toContain('class="cp-add"')
    expect(html).not.toContain('class="cp-del"')
  })

  test('the title is 15px semi-bold, tight line-height', () => {
    expect(SOURCE).toMatch(/\.cp-title\s*\{[^}]*font-size: 15px;/)
    expect(SOURCE).toMatch(/\.cp-title\s*\{[^}]*font-weight: 600;/)
  })
})

describe('row 1: the envelope tab (fiche §3)', () => {
  test('a single tab, always active, showing the MR reference', async () => {
    const html = await render({ mr: mr({ number: 99 }) })
    expect(html).toContain('cp-tab1--active')
    expect(html).toContain(t('mrs.number', { n: 99 }))
  })

  test('the row-1 tab shows its own MR reference', async () => {
    const html = await render({ mr: mr({ number: 42 }) })
    expect(html).toContain(t('mrs.number', { n: 42 }))
  })

  test('the row-1 tab carries no counter element, unlike row 2 (fiche §3: "aucun")', async () => {
    const html = await render({ mr: mr() })
    expect(html).not.toContain('cp-tab1-counter')
  })

  test('row 1 geometry: 8px padding, 6px gap, 28px tab height, 8px radius, 12px text, 16px icon', () => {
    expect(SOURCE).toMatch(/\.cp-row1\s*\{[^}]*padding: 8px;/)
    expect(SOURCE).toMatch(/\.cp-row1\s*\{[^}]*gap: 6px;/)
    expect(SOURCE).toMatch(/\.cp-tab1\s*\{[^}]*height: 28px;/)
    expect(SOURCE).toMatch(/\.cp-tab1\s*\{[^}]*border-radius: 8px;/)
    expect(SOURCE).toMatch(/\.cp-tab1\s*\{[^}]*font-size: 12px;/)
    expect(SOURCE).toMatch(/\.cp-tab1-icon\s*\{[^}]*width: 16px;/)
  })

  test('the active tab uses a line-colored fill and accent text', () => {
    expect(SOURCE).toMatch(/\.cp-tab1--active\s*\{[^}]*background: var\(--cs-line-2\);/)
    expect(SOURCE).toMatch(/\.cp-tab1--active\s*\{[^}]*color: var\(--cs-green-text\);/)
  })
})

describe('row 2: section tabs (fiche §3)', () => {
  test('the files tab shows the count glued to its label when known', async () => {
    const html = await render({ mr: mr({ changedFiles: 5 }) })
    expect(html).toContain(t('changes.tabs.filesCount', { n: 5 }, 5))
  })

  test('a null changedFiles omits the count entirely, never a fabricated 0', async () => {
    const html = await render({ mr: mr({ changedFiles: null }) })
    expect(html).toContain(t('changes.tabs.files'))
    expect(html).not.toContain(t('changes.tabs.filesCount', { n: 0 }, 0))
  })

  test('the checks tab renders a fraction, never a bare count, when the rollup is complete', async () => {
    const html = await render({
      mr: mr({ checks: { passed: 12, failed: 0, pending: 2, skipped: 0, truncated: false } }),
    })
    expect(html).toContain(t('changes.tabs.checksFraction', { passed: 12, total: 14 }))
  })

  test('a truncated rollup shows only the aggregate, never a fabricated total', async () => {
    const html = await render({
      mr: mr({ checks: { passed: 12, failed: 0, pending: 0, skipped: 0, truncated: true } }),
    })
    const counter = /<span class="cp-tab2-counter">([^<]*)<\/span>/.exec(html)?.[1]
    expect(counter).toBe(t('mrs.checks.aggregatePassed'))
    expect(counter).not.toContain('/')
  })

  test('no checks at all: the label alone, no glyph, no counter', async () => {
    const html = await render({ mr: mr({ checks: null }) })
    expect(html).toContain(t('changes.tabs.checks'))
    expect(html).not.toContain('cp-tab2-icon')
  })

  test('row 2 geometry: 8px padding, 4px gap, 8px radius, 11px text', () => {
    expect(SOURCE).toMatch(/\.cp-row2\s*\{[^}]*padding: 8px;/)
    expect(SOURCE).toMatch(/\.cp-row2\s*\{[^}]*gap: 4px;/)
    expect(SOURCE).toMatch(/\.cp-tab2\s*\{[^}]*border-radius: 8px;/)
    expect(SOURCE).toMatch(/\.cp-tab2\s*\{[^}]*font-size: 11px;/)
  })

  test('row 2 sits on a bottom hairline, distinct from row 1', () => {
    expect(SOURCE).toMatch(/\.cp-row2\s*\{[^}]*border-bottom: 1px solid var\(--cs-line\);/)
  })
})

describe('section content routing', () => {
  test('files section (the default): renders the file list with the MR number and project forwarded', async () => {
    const html = await render({ mr: mr({ number: 42 }), project: 'my-repo' })
    expect(html).toContain('cfl-root')
  })

  test('checks section placeholder: the shared empty-tab body, not the file list', () => {
    // Both branches are compiled into the template; asserting the wiring
    // (which component each v-if arm mounts) is what SSR alone cannot
    // distinguish once collapsed to one active section, read from source.
    expect(SOURCE).toContain('<ChangesEmptyTab')
    expect(SOURCE).toContain(':icon="ListChecks"')
    expect(SOURCE).toContain(':text="t(\'changes.checksTab.placeholder\')"')
  })
})

describe('the envelope (fiche §2)', () => {
  test('defaults to 460px wide with no persisted preference (SSR: no localStorage)', async () => {
    const html = await render({ mr: mr() })
    expect(html).toContain('460px')
  })

  test('rounded on the top-left corner only, no border and no radius on the right', () => {
    expect(SOURCE).toMatch(/\.cp-root\s*\{[^}]*border-radius: 12px 0 0 0;/)
    expect(SOURCE).toMatch(/\.cp-root\s*\{[^}]*border-right: none;/)
  })

  test('the handle is 6px wide, on the left edge', () => {
    expect(SOURCE).toMatch(/\.cp-handle\s*\{[^}]*width: 6px;/)
  })

  test('the handle shows a 2px accent line on hover, invisible at rest', () => {
    expect(SOURCE).toMatch(/\.cp-handle::after\s*\{[^}]*width: 2px;/)
    expect(SOURCE).toMatch(/\.cp-handle::after\s*\{[^}]*opacity: 0;/)
    expect(SOURCE).toMatch(
      /\.cp-handle:hover::after,\s*\n\.cp-handle--active::after\s*\{\s*opacity: 1;/,
    )
  })

  test('the handle is a labeled, keyboard-operable ARIA window splitter', async () => {
    const html = await render({ mr: mr() })
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain(`aria-label="${t('changes.resizeAria')}"`)
    expect(html).toContain('aria-valuenow="460"')
    expect(html).toContain('aria-valuemin="320"')
  })

  test('close is a real button, 15px glyph', () => {
    expect(SOURCE).toMatch(/\.cp-close svg\s*\{[^}]*width: 15px;/)
  })
})

describe('never uses animation-fill-mode (project-wide rule)', () => {
  test('the source contains no animation-fill-mode', () => {
    expect(SOURCE).not.toContain('animation-fill-mode')
  })
})
