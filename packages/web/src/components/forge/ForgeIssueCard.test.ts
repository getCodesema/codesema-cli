// Same harness as MrCard.test.ts / WorkspaceHeader.test.ts.
import { expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeIssue } from '../../types'

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

function baseIssue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 7,
    title: 'Add forge board screen',
    body: '',
    state: 'open',
    labels: [
      { name: 'ui', color: null },
      { name: 'backend', color: null },
    ],
    author: 'octocat',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    url: 'https://example.test/issues/7',
    ...overrides,
  }
}

async function renderCard(issue: ForgeIssue): Promise<string> {
  const ForgeIssueCard = (await import('./ForgeIssueCard.vue')).default
  const app = createSSRApp(ForgeIssueCard, { issue })
  return renderToString(app)
}

test('renders the number, title and author', async () => {
  const html = await renderCard(baseIssue())
  expect(html).toContain(t('mrs.number', { n: 7 }))
  expect(html).toContain('Add forge board screen')
  expect(html).toContain('octocat')
})

test('renders every label', async () => {
  const html = await renderCard(
    baseIssue({
      labels: [
        { name: 'ui', color: null },
        { name: 'backend', color: null },
      ],
    }),
  )
  expect(html).toContain('ui')
  expect(html).toContain('backend')
})

test('an empty label list renders no label chip', async () => {
  const html = await renderCard(baseIssue({ labels: [] }))
  expect(html).not.toContain('fic-label"')
})

test('a labeled color drives the pill fill, a null color falls back to the neutral token', async () => {
  const colored = await renderCard(baseIssue({ labels: [{ name: 'bug', color: 'd73a4a' }] }))
  expect(colored).toContain('rgba(215, 58, 74, 0.16)')

  const neutral = await renderCard(baseIssue({ labels: [{ name: 'bug', color: null }] }))
  expect(neutral).toContain('var(--cs-line-2)')
  expect(neutral).not.toContain('rgba(')
})

test('the empty string body is not rendered as a degradation of any kind', async () => {
  const html = await renderCard(baseIssue({ body: '' }))
  expect(html).not.toContain('undefined')
  expect(html).not.toContain('null')
})
