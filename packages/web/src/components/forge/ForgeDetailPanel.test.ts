// Same harness as ForgeBoard.test.ts.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeMr } from '../../types'
import type { ForgeDetailItem } from './ForgeLogic'

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

/** Vue SSR escapes attribute values (an aria-label carrying a literal `"`
 * around the title comes back as `&quot;`): match what the markup actually
 * contains rather than the raw i18n string. */
function htmlEscapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

async function render(item: ForgeDetailItem | null): Promise<string> {
  const ForgeDetailPanel = (await import('./ForgeDetailPanel.vue')).default
  const app = createSSRApp(ForgeDetailPanel, { item })
  return renderToString(app)
}

describe('an issue selection', () => {
  test('renders the issue card content and links to its forge URL', async () => {
    const html = await render({
      kind: 'issue',
      issue: issue({ title: 'fix the thing', url: 'https://example.test/issues/9' }),
    })
    expect(html).toContain('fix the thing')
    expect(html).toContain('href="https://example.test/issues/9"')
    expect(html).toContain(htmlEscapeAttr(t('forge.openItemAria', { title: 'fix the thing' })))
  })

  test('carries the close action, labeled', async () => {
    const html = await render({ kind: 'issue', issue: issue() })
    expect(html).toContain(t('forge.detailClose'))
  })
})

describe('an MR selection', () => {
  test('renders the MR card content and links to its forge URL', async () => {
    const html = await render({
      kind: 'mr',
      mr: mr({ title: 'ship the feature', url: 'https://example.test/mr/7' }),
    })
    expect(html).toContain('ship the feature')
    expect(html).toContain('href="https://example.test/mr/7"')
    expect(html).toContain(htmlEscapeAttr(t('forge.openItemAria', { title: 'ship the feature' })))
  })
})

describe('the external link opens in a new tab, safely', () => {
  test('target=_blank with rel=noopener noreferrer', async () => {
    const html = await render({ kind: 'issue', issue: issue() })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

// This panel stays on screen at all times, not conditioned on a selection: a
// clean empty state replaces the "panel absent" behavior.
describe('no selection: a clean empty state, never an absent panel', () => {
  test('null renders the empty-state message, no header, no card', async () => {
    const html = await render(null)
    expect(html).toContain(t('forge.detailEmpty'))
    expect(html).not.toContain(t('forge.detailTitle'))
    expect(html).not.toContain(t('forge.detailClose'))
    expect(html).not.toContain('fic-root')
    expect(html).not.toContain('mrc-root')
  })

  test('a selection replaces the empty state entirely', async () => {
    const html = await render({ kind: 'issue', issue: issue({ title: 'not empty any more' }) })
    expect(html).not.toContain(t('forge.detailEmpty'))
    expect(html).toContain('not empty any more')
  })
})
