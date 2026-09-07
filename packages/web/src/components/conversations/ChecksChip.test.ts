// Same harness as ConversationRow.test.ts: `vue/compiler-sfc` compiles the SFC
// with its template inlined, then `vue/server-renderer` renders to a STRING
// (no DOM). CSS-only facts are pinned by slicing the raw source, the same
// escape hatch ForgeControlsPanel.test.ts uses for its own chevron rotation.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ReferencePill } from './ConversationsLogic'

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

const SOURCE = readFileSync(join(import.meta.dir, 'ChecksChip.vue'), 'utf8')

async function render(pill: ReferencePill): Promise<string> {
  const ChecksChip = (await import('./ChecksChip.vue')).default
  const app = createSSRApp(ChecksChip, { pill })
  return renderToString(app)
}

describe('glyph and text', () => {
  test('a check glyph renders the lucide check icon and the text verbatim', async () => {
    const html = await render({ tone: 'green', glyph: 'check', text: 'Checks passed' })
    expect(html).toContain('lucide-check')
    expect(html).toContain('Checks passed')
  })

  test('an x glyph renders the lucide x icon', async () => {
    const html = await render({ tone: 'red', glyph: 'x', text: 'Checks failed' })
    expect(html).toContain('lucide-x')
    expect(html).toContain('Checks failed')
  })

  test('an alert-triangle glyph renders the lucide alert-triangle icon', async () => {
    const html = await render({ tone: 'red', glyph: 'alert-triangle', text: 'Merge conflict' })
    expect(html).toContain('lucide-triangle-alert')
    expect(html).toContain('Merge conflict')
  })

  test('a dot glyph renders a static dot, never an icon component or a spin class', async () => {
    const html = await render({ tone: 'amber', glyph: 'dot', text: 'Checks running' })
    expect(html).toContain('cc-dot')
    expect(html).not.toContain('lucide-')
    expect(html).not.toContain('spin')
  })
})

describe('tone', () => {
  test('each tone applies its own class', async () => {
    for (const tone of ['red', 'amber', 'green'] as const) {
      const html = await render({ tone, glyph: 'check', text: 'x' })
      expect(html).toContain(`cc-pill--${tone}`)
    }
  })
})

describe('the pill border colour is reserved to a checks state, never decorative', () => {
  test('the base pill border is neutral, no state colour of its own', () => {
    const rule = SOURCE.slice(SOURCE.indexOf('.cc-pill {'), SOURCE.indexOf('.cc-pill-icon {'))
    expect(rule).toContain('border: 1px solid var(--cs-line-2);')
    expect(rule).not.toContain('--cs-red')
    expect(rule).not.toContain('--cs-amber')
    expect(rule).not.toContain('--cs-green')
  })

  test('each tone overrides the border colour with its own state token', () => {
    function ruleBody(selector: string): string {
      const at = SOURCE.indexOf(selector)
      return SOURCE.slice(at, SOURCE.indexOf('}', at))
    }
    expect(ruleBody('.cc-pill--red')).toContain('--cs-red-line')
    expect(ruleBody('.cc-pill--amber')).toContain('--cs-amber-line')
    expect(ruleBody('.cc-pill--green')).toContain('--cs-green-ring')
  })
})
