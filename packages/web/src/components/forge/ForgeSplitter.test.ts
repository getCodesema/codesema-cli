// Same harness as ForgeBoard.test.ts. Pointer drag and keyboard math are
// pure functions (widthAfterDrag/widthAfterKey, ForgeLogic.test.ts): this
// file only checks the ARIA "window splitter" markup a given prop bag
// renders, which is all an SSR string render can exercise.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

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
  modelValue: number
  min: number
  max: number
  defaultWidth: number
  ariaLabel: string
}

async function render(props: Props): Promise<string> {
  const ForgeSplitter = (await import('./ForgeSplitter.vue')).default
  const app = createSSRApp(ForgeSplitter, props)
  return renderToString(app)
}

describe('ForgeSplitter: ARIA window-splitter markup', () => {
  test('renders as a vertical separator, focusable, labeled by the caller', async () => {
    const html = await render({
      modelValue: 288,
      min: 220,
      max: 460,
      defaultWidth: 288,
      ariaLabel: 'Resize the controls panel',
    })
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Resize the controls panel"')
  })

  test('exposes the current value and bounds as aria-valuenow/min/max', async () => {
    const html = await render({
      modelValue: 340,
      min: 220,
      max: 460,
      defaultWidth: 288,
      ariaLabel: 'x',
    })
    expect(html).toContain('aria-valuenow="340"')
    expect(html).toContain('aria-valuemin="220"')
    expect(html).toContain('aria-valuemax="460"')
  })

  test('aria-valuenow rounds a fractional width', async () => {
    const html = await render({
      modelValue: 340.6,
      min: 220,
      max: 460,
      defaultWidth: 288,
      ariaLabel: 'x',
    })
    expect(html).toContain('aria-valuenow="341"')
  })

  test('is not marked active before any drag has started', async () => {
    const html = await render({
      modelValue: 288,
      min: 220,
      max: 460,
      defaultWidth: 288,
      ariaLabel: 'x',
    })
    expect(html).not.toContain('fs-handle--active')
  })
})
