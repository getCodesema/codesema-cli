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
    labels: ['ui', 'backend'],
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
  const html = await renderCard(baseIssue({ labels: ['ui', 'backend'] }))
  expect(html).toContain('ui')
  expect(html).toContain('backend')
})

test('an empty label list renders no label chip', async () => {
  const html = await renderCard(baseIssue({ labels: [] }))
  expect(html).not.toContain('fic-label"')
})

test('the empty string body is not rendered as a degradation of any kind', async () => {
  const html = await renderCard(baseIssue({ body: '' }))
  expect(html).not.toContain('undefined')
  expect(html).not.toContain('null')
})
