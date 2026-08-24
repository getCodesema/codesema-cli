// Same harness as MrCard.test.ts / WorkspaceHeader.test.ts.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { LabelCount } from './ForgeLogic'

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

async function render(counts: LabelCount[], selected: string[]): Promise<string> {
  const LabelChips = (await import('./LabelChips.vue')).default
  const app = createSSRApp(LabelChips, { counts, selected })
  return renderToString(app)
}

describe('LabelChips', () => {
  test('renders one chip per label with its count', async () => {
    const html = await render(
      [
        { label: 'bug', count: 3 },
        { label: 'ui', count: 1 },
      ],
      [],
    )
    expect(html).toContain('bug')
    expect(html).toContain('>3<')
    expect(html).toContain('ui')
    expect(html).toContain('>1<')
  })

  test('a selected label is marked aria-pressed=true, others false', async () => {
    const html = await render(
      [
        { label: 'bug', count: 3 },
        { label: 'ui', count: 1 },
      ],
      ['bug'],
    )
    const bugAt = html.indexOf('bug')
    const uiAt = html.indexOf('ui')
    // Each chip's own button tag carries its aria-pressed just before its label text.
    const bugTag = html.lastIndexOf('<button', bugAt)
    const uiTag = html.lastIndexOf('<button', uiAt)
    expect(html.slice(bugTag, bugAt)).toContain('aria-pressed="true"')
    expect(html.slice(uiTag, uiAt)).toContain('aria-pressed="false"')
  })

  test('an empty count list renders nothing at all', async () => {
    const html = await render([], [])
    expect(html).not.toContain('lc-chip')
    expect(html).not.toContain('lc-root')
  })
})
