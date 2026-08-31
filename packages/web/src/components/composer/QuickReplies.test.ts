// SSR string-render tests, same harness as ChatComposer.test.ts: the click
// handlers (`emit('pick', option)`, `emit('other')`) are not observable here
// since `renderToString` never triggers a DOM event — this file only checks
// the markup a given prop bag renders.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'

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

type Props = {
  options: string[]
  disabled?: boolean
}

async function render(props: Props): Promise<string> {
  const QuickReplies = (await import('./QuickReplies.vue')).default
  const app = createSSRApp(QuickReplies, props)
  return renderToString(app)
}

describe('QuickReplies: renders nothing without options', () => {
  test('an empty options list renders no markup at all', async () => {
    const html = await render({ options: [] })
    expect(html.trim()).toBe('<!--v-if-->')
  })
})

describe('QuickReplies: one button per option, plus the "other" escape hatch', () => {
  test('each option becomes its own button, arrow-prefixed', async () => {
    const html = await render({ options: ['v2', 'the optional field'] })
    expect(html).toContain('→ v2')
    expect(html).toContain('→ the optional field')
  })

  test('the "other" button carries the shared quickReplyOther string', async () => {
    const html = await render({ options: ['v2', 'v3'] })
    expect(html).toContain(t('workspace.quickReplyOther'))
  })

  test('option buttons are type="button" so they never submit a form', async () => {
    const html = await render({ options: ['A', 'B'] })
    const buttons = [...html.matchAll(/<button[^>]*class="qr-opt"[^>]*>/g)].map((m) => m[0])
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toContain('type="button"')
    }
  })
})

describe('QuickReplies: disabled state only reaches the option buttons', () => {
  test('disabled marks every option button', async () => {
    const html = await render({ options: ['A', 'B'], disabled: true })
    const buttons = [...html.matchAll(/<button[^>]*class="qr-opt"[^>]*>/g)].map((m) => m[0])
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toContain('disabled')
    }
  })

  test('the "other" button is never disabled', async () => {
    const html = await render({ options: ['A', 'B'], disabled: true })
    const match = html.match(/<button[^>]*class="qr-other"[^>]*>/)
    expect(match).not.toBeNull()
    expect(match?.[0]).not.toContain('disabled')
  })

  test('undefined disabled leaves the option buttons enabled', async () => {
    const html = await render({ options: ['A'] })
    const match = html.match(/<button[^>]*class="qr-opt"[^>]*>/)
    expect(match).not.toBeNull()
    expect(match?.[0]).not.toContain('disabled')
  })
})
