import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

const SOURCE = readFileSync(join(import.meta.dir, 'ChangesEmptyTab.vue'), 'utf8')

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

const DummyIcon = { name: 'DummyIcon', render: () => h('svg', { class: 'dummy-icon-mark' }) }

async function render(text: string): Promise<string> {
  const ChangesEmptyTab = (await import('./ChangesEmptyTab.vue')).default
  const app = createSSRApp(ChangesEmptyTab, { icon: DummyIcon, text })
  return renderToString(app)
}

describe('ChangesEmptyTab', () => {
  test('renders the given icon and text', async () => {
    const html = await render('Nothing to show here')
    expect(html).toContain('dummy-icon-mark')
    expect(html).toContain('Nothing to show here')
  })

  test('the icon is decorative, hidden from assistive tech', async () => {
    const html = await render('x')
    expect(html).toContain('aria-hidden="true"')
  })

  test('fiche §7: 48px vertical padding', () => {
    expect(SOURCE).toMatch(/\.cet-root\s*\{[^}]*padding: 48px 16px;/)
  })

  test('never uses animation-fill-mode (project-wide rule)', () => {
    expect(SOURCE).not.toContain('animation-fill-mode')
  })
})
