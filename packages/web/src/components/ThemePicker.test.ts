// Same harness as the rail tests: SSR-string render via createSSRApp +
// renderToString + the Bun plugin that compiles .vue with vue/compiler-sfc.
// Scoped-style values are not visible in SSR output, so those are pinned by
// slicing the raw source instead.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { G } from '../glyphs'
import { t } from '../i18n'
import { DEFAULT_PALETTE, PALETTES } from '../theme'

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

const SOURCE = readFileSync(join(import.meta.dir, 'ThemePicker.vue'), 'utf8')

type Props = { compact?: boolean; collapsed?: boolean }

async function render(props: Props = {}): Promise<string> {
  const ThemePicker = (await import('./ThemePicker.vue')).default
  const app = createSSRApp(ThemePicker, props)
  return renderToString(app)
}

describe('compact shape: one select for the palette, one segment for the contrast', () => {
  test('the select lists every palette the theme module declares', async () => {
    const html = await render({ compact: true })
    const options = [...html.matchAll(/<option[^>]*value="([^"]+)"/g)].map((match) => match[1])
    expect(options).toHaveLength(10)
    expect(options).toEqual(PALETTES.map((palette) => palette.id))
  })

  // SSR does not resolve v-model on a <select> into a `selected` attribute,
  // so the binding is pinned on the source and the default on the module.
  test('the select is bound to the palette, whose default option is Ink', async () => {
    const html = await render({ compact: true })
    expect(SOURCE).toContain('v-model="palette"')
    expect(DEFAULT_PALETTE).toBe('ink')
    expect(html).toContain(`value="${DEFAULT_PALETTE}"`)
  })

  test('both controls are named, on the existing settings keys', async () => {
    const html = await render({ compact: true })
    expect(html).toContain(`aria-label="${t('settings.paletteLabel')}"`)
    expect(html).toContain(`aria-label="${t('settings.contrastLabel')}"`)
  })

  test('the contrast segment offers exactly AA and AAA, AA pressed by default', async () => {
    const html = await render({ compact: true })
    const buttons = [...html.matchAll(/<button type="button"([^>]*aria-pressed[^>]*)>/g)]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.[1]).toContain('aria-pressed="true"')
    expect(buttons[1]?.[1]).toContain('aria-pressed="false"')
    expect(html).toContain(t('settings.contrastAa'))
    expect(html).toContain(t('settings.contrastAaa'))
  })

  test('compact carries no panel frame around it', async () => {
    const html = await render({ compact: true })
    expect(html).not.toContain('panel-title')
  })
})

describe('collapsed rail: a single swap button that opens the rail back up', () => {
  test('only the swap glyph renders, named for a screen reader', async () => {
    const html = await render({ compact: true, collapsed: true })
    expect(html).toContain('tp-swap')
    expect(html).toContain(G.swap)
    expect(html).toContain(`aria-label="${t('settings.paletteLabel')}"`)
    expect(html).not.toContain('<select')
  })

  test('collapsed only applies in compact mode: the panel ignores it', async () => {
    const html = await render({ collapsed: true })
    expect(html).not.toContain('tp-swap')
    expect(html).toContain('panel-title')
  })
})

describe('no colour is spelled out: only theme tokens, never a plain hex', () => {
  test('the style block holds no hex, no rgba, no radius, no shadow', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
    expect(styleBlock).not.toContain('rgba(')
    expect(styleBlock).not.toContain('border-radius')
    expect(styleBlock).not.toContain('box-shadow')
  })
})
