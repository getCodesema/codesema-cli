// Same harness as MrCard.test.ts / WorkspaceHeader.test.ts, extended with `h`
// to pass slots: createSSRApp's root options accept a `render` function that
// hands the child its slots directly (no `mount`, still no DOM).
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
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
  label: string
  count: number | string | null
  truncatedHint: string | null
  open: boolean
}

async function render(
  props: Props,
  slots: { default?: () => string; filters?: () => string; labels?: () => string } = {},
): Promise<string> {
  const RadarAccordion = (await import('./RadarAccordion.vue')).default
  const app = createSSRApp({
    render: () => h(RadarAccordion, props, slots),
  })
  return renderToString(app)
}

describe('fold state', () => {
  test('closed: chevron points right, body and slots are not rendered', async () => {
    const html = await render(
      { label: 'Issues', count: 3, truncatedHint: null, open: false },
      { default: () => 'BODY_MARK', filters: () => 'FILTERS_MARK', labels: () => 'LABELS_MARK' },
    )
    expect(html).toContain('▸')
    expect(html).not.toContain('▾')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('BODY_MARK')
    expect(html).not.toContain('FILTERS_MARK')
    expect(html).not.toContain('LABELS_MARK')
  })

  test('open: chevron points down, body and slots render', async () => {
    const html = await render(
      { label: 'Issues', count: 3, truncatedHint: null, open: true },
      { default: () => 'BODY_MARK', filters: () => 'FILTERS_MARK', labels: () => 'LABELS_MARK' },
    )
    expect(html).toContain('▾')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('BODY_MARK')
    expect(html).toContain('FILTERS_MARK')
    expect(html).toContain('LABELS_MARK')
  })
})

describe('count', () => {
  test('a known count renders as a badge', async () => {
    const html = await render({ label: 'Issues', count: 12, truncatedHint: null, open: true })
    expect(html).toContain('>12<')
  })

  test('a null count (unknown: loading, error, unavailable) renders no badge at all', async () => {
    const html = await render({ label: 'Issues', count: null, truncatedHint: null, open: true })
    expect(html).not.toContain('ra-count')
  })

  test('a measured zero still renders, distinct from null', async () => {
    const html = await render({ label: 'Issues', count: 0, truncatedHint: null, open: true })
    expect(html).toContain('ra-count')
    expect(html).toContain('>0<')
  })

  test('a caller-formatted string count (a filtered "shown / total") renders verbatim', async () => {
    const html = await render({ label: 'Issues', count: '1 / 25', truncatedHint: null, open: true })
    expect(html).toContain('>1 / 25<')
  })
})

describe('truncation caveat', () => {
  test('absent when truncatedHint is null', async () => {
    const html = await render({ label: 'Issues', count: 5, truncatedHint: null, open: true })
    expect(html).not.toContain('ra-truncated')
  })

  test('shown verbatim when truncatedHint is set', async () => {
    const html = await render({
      label: 'Issues',
      count: 5,
      truncatedHint: '5 shown, the forge has more.',
      open: true,
    })
    expect(html).toContain('5 shown, the forge has more.')
  })
})

describe('optional controls slots', () => {
  test('no controls row at all when neither filters nor labels slot is given', async () => {
    const html = await render(
      { label: 'Issues', count: 5, truncatedHint: null, open: true },
      { default: () => 'BODY_MARK' },
    )
    expect(html).not.toContain('ra-controls')
    expect(html).toContain('BODY_MARK')
  })
})
