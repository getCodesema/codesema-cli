// Same harness as ForgeBoard.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeSection } from './ForgePrefs'

const SOURCE = readFileSync(join(import.meta.dir, 'ForgeControlsPanel.vue'), 'utf8')

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

type Props = { activeSection: ForgeSection; collapsed: boolean; projectName: string }

async function render(props: Props): Promise<string> {
  const ForgeControlsPanel = (await import('./ForgeControlsPanel.vue')).default
  const app = createSSRApp(ForgeControlsPanel, props)
  return renderToString(app)
}

/** The two nav buttons, in DOM order, as [label, pressed] pairs. Attributes
 * come before the text node in the markup, so a plain slice-on-label-text
 * cut would miss the very `aria-pressed` it means to check. */
function navButtonsOf(html: string): Array<{ label: string; pressed: string }> {
  const pattern =
    /<button type="button" class="fcp-nav-item[^"]*" aria-pressed="(true|false)">([^<]+)<\/button>/g
  return [...html.matchAll(pattern)].map((m) => ({ pressed: m[1] ?? '', label: m[2] ?? '' }))
}

describe('expanded: the section nav shows both sections, the active one pressed', () => {
  test('issues active: pressed, pull requests not', async () => {
    const html = await render({ activeSection: 'issues', collapsed: false, projectName: 'demo' })
    const buttons = navButtonsOf(html)
    expect(buttons).toEqual([
      { label: t('forge.issuesTitle'), pressed: 'true' },
      { label: t('forge.mrsTitle'), pressed: 'false' },
    ])
  })

  test('pull requests active: pressed, issues not', async () => {
    const html = await render({ activeSection: 'mrs', collapsed: false, projectName: 'demo' })
    const buttons = navButtonsOf(html)
    expect(buttons).toEqual([
      { label: t('forge.issuesTitle'), pressed: 'false' },
      { label: t('forge.mrsTitle'), pressed: 'true' },
    ])
  })

  test('the collapse toggle reads "collapse", expanded (aria-expanded true)', async () => {
    const html = await render({ activeSection: 'issues', collapsed: false, projectName: 'demo' })
    expect(html).toContain(t('forge.controlsCollapse'))
    expect(html).not.toContain(t('forge.controlsExpand'))
    expect(html).toContain('aria-expanded="true"')
  })

  test('no collapsed band while expanded', async () => {
    const html = await render({ activeSection: 'issues', collapsed: false, projectName: 'demo' })
    expect(html).not.toContain('fcp-band')
  })
})

// The collapsed controls panel is not a bare toggle: the whole band carries
// the project name (vertical writing mode, CSS-only, unverifiable via this
// SSR string render, so the class/attribute contract below is what IS
// verifiable), and the band itself is the reopen control.
describe('collapsed: a full-band reopen control carrying the project name, the section nav is gone', () => {
  test('neither section label is rendered as a nav button', async () => {
    const html = await render({ activeSection: 'issues', collapsed: true, projectName: 'demo' })
    expect(html).not.toContain('fcp-nav-item')
  })

  test('no separate small collapse toggle remains: the band itself is the control', async () => {
    const html = await render({ activeSection: 'issues', collapsed: true, projectName: 'demo' })
    expect(html).not.toContain('class="fcp-collapse"')
  })

  test('the band carries the project name, truncatable, and reads as the expand control', async () => {
    const html = await render({ activeSection: 'issues', collapsed: true, projectName: 'my-repo' })
    expect(html).toContain('class="fcp-band"')
    expect(html).toContain('class="fcp-band-name"')
    expect(html).toContain('>my-repo<')
    expect(html).toContain('title="my-repo"')
    expect(html).toContain(t('forge.controlsExpand'))
    expect(html).not.toContain(t('forge.controlsCollapse'))
    expect(html).toContain('aria-expanded="false"')
  })

  test('the whole band is a single button element (the entire strip reopens it)', async () => {
    const html = await render({ activeSection: 'issues', collapsed: true, projectName: 'demo' })
    expect((html.match(/<button/g) ?? []).length).toBe(1)
  })
})

// The writing-mode flip is CSS-only, unreachable through an SSR string
// render (same limitation as ProjectsNav.test.ts's own geometry pins):
// pinned on the raw source instead.
describe('the band orientation: CSS-pinned', () => {
  test('the name is vertical, top-to-bottom, by default', () => {
    const bandName = SOURCE.slice(
      SOURCE.indexOf('.fcp-band-name {'),
      SOURCE.indexOf('/* Below the shell'),
    )
    expect(bandName).toContain('writing-mode: vertical-rl;')
  })

  test("below the shell's own 640px, the band becomes horizontal, the name no longer rotated", () => {
    const narrow = SOURCE.slice(SOURCE.indexOf('@container fb-shell (max-width: 640px) {'))
    expect(narrow).toContain('writing-mode: horizontal-tb;')
    expect(narrow).toContain('height: 48px;')
  })
})
