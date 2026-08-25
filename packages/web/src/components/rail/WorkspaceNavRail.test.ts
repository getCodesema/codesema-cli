// Same harness as the other rail tests: SSR-string render via createSSRApp +
// renderToString + the Bun plugin that compiles .vue with vue/compiler-sfc.
// Scoped-style values (widths, tokens) are not visible in SSR output, so
// those are pinned by slicing the raw source instead, like that file does
// for its own menu geometry.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const SOURCE = readFileSync(join(import.meta.dir, 'WorkspaceNavRail.vue'), 'utf8')

type NavCategory = 'conversations' | 'repositories'

type Props = {
  category: NavCategory
  collapsed: boolean
  needsYou: number | null
}

function props(overrides: Partial<Props> = {}): Props {
  return { category: 'conversations', collapsed: false, needsYou: null, ...overrides }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const WorkspaceNavRail = (await import('./WorkspaceNavRail.vue')).default
  const app = createSSRApp(WorkspaceNavRail, props(overrides))
  return renderToString(app)
}

function catButtons(html: string): RegExpMatchArray[] {
  return [...html.matchAll(/<button type="button" class="wnr-cat[^"]*"([^>]*)>/g)]
}

describe('categories: both render, the active one carries the tinted accent', () => {
  test('both category labels render', async () => {
    const html = await render()
    expect(html).toContain(t('rail.conversations'))
    expect(html).toContain(t('rail.repositories'))
  })

  test('conversations active by default: aria-pressed true on it, false on repositories', async () => {
    const html = await render({ category: 'conversations' })
    const buttons = catButtons(html)
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.[1]).toContain('aria-pressed="true"')
    expect(buttons[1]?.[1]).toContain('aria-pressed="false"')
  })

  test('switching to repositories flips the active state', async () => {
    const html = await render({ category: 'repositories' })
    const buttons = catButtons(html)
    expect(buttons[0]?.[1]).toContain('aria-pressed="false"')
    expect(buttons[1]?.[1]).toContain('aria-pressed="true"')
  })

  test('the active category carries the wnr-cat--active class, the inactive one does not', async () => {
    const html = await render({ category: 'repositories' })
    const buttons = catButtons(html)
    expect(buttons[0]?.[0]).not.toContain('wnr-cat--active')
    expect(buttons[1]?.[0]).toContain('wnr-cat--active')
  })

  test('the active row uses the tinted fill token, no border', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('.wnr-cat--active {'),
      SOURCE.indexOf('.wnr-cat--active .wnr-row-icon'),
    )
    expect(block).toContain('background: var(--cs-green-soft);')
    expect(block).not.toContain('border-color')
  })

  test('the active row accents its own icon on top of the tinted fill', () => {
    expect(SOURCE).toContain('.wnr-cat--active .wnr-row-icon {')
    const block = SOURCE.slice(
      SOURCE.indexOf('.wnr-cat--active .wnr-row-icon {'),
      SOURCE.indexOf('.wnr-icon-slot {'),
    )
    expect(block).toContain('color: var(--cs-green-text);')
  })
})

describe('collapsed state: labels absent from markup, aria-label present', () => {
  test('expanded: labels render, no aria-label on category buttons (visible text carries the name)', async () => {
    const html = await render({ collapsed: false })
    expect(html).toContain('wnr-cat-label')
    const buttons = catButtons(html)
    expect(buttons).toHaveLength(2)
    expect(buttons.every((m) => !(m[1] ?? '').includes('aria-label'))).toBe(true)
  })

  test('collapsed: labels absent, aria-label present on both category buttons', async () => {
    const html = await render({ collapsed: true })
    expect(html).not.toContain('wnr-cat-label')
    const buttons = catButtons(html)
    expect(buttons).toHaveLength(2)
    expect(buttons.every((m) => (m[1] ?? '').includes('aria-label'))).toBe(true)
    expect(html).toContain(`aria-label="${t('rail.conversations')}"`)
    expect(html).toContain(`aria-label="${t('rail.repositories')}"`)
  })

  test('collapsed: the settings row loses its label but keeps an aria-label', async () => {
    const html = await render({ collapsed: true })
    expect(html).not.toContain('wnr-settings-label')
    expect(html).toContain(`aria-label="${t('nav.settings')}"`)
  })

  test('expanded: the settings row shows its label and carries no aria-label', async () => {
    const html = await render({ collapsed: false })
    expect(html).toContain('wnr-settings-label')
    expect(html).toContain(t('nav.settings'))
  })

  test('every row keeps its title regardless of collapse state', async () => {
    const collapsedHtml = await render({ collapsed: true })
    const expandedHtml = await render({ collapsed: false })
    for (const html of [collapsedHtml, expandedHtml]) {
      expect(html).toContain(`title="${t('rail.conversations')}"`)
      expect(html).toContain(`title="${t('rail.repositories')}"`)
      expect(html).toContain(`title="${t('nav.settings')}"`)
    }
  })

  test('the collapsed track is 56px, the expanded track 215px', () => {
    expect(SOURCE).toContain('width: 215px;')
    expect(SOURCE).toContain('width: 56px;')
  })

  test('the toggle button label flips between collapse and expand', async () => {
    const expandedHtml = await render({ collapsed: false })
    const collapsedHtml = await render({ collapsed: true })
    expect(expandedHtml).toContain(t('rail.collapse'))
    expect(collapsedHtml).toContain(t('rail.expand'))
  })
})

describe('needsYou badge: absent when null, present when a positive number', () => {
  test('null: no count pill anywhere', async () => {
    const html = await render({ needsYou: null })
    expect(html).not.toContain('wnr-count-pill')
  })

  test('zero: still no pill, nothing to flag', async () => {
    const html = await render({ needsYou: 0 })
    expect(html).not.toContain('wnr-count-pill')
  })

  test('a positive number: the pill renders with that count', async () => {
    const html = await render({ needsYou: 3 })
    expect(html).toContain('wnr-count-pill')
    expect(html).toContain('>3<')
  })

  test('the pill only ever appears on the conversations row, never repositories', async () => {
    const html = await render({ needsYou: 5, category: 'repositories' })
    const repositoriesButton = catButtons(html)[1]?.[0] ?? ''
    expect(repositoriesButton).not.toContain('wnr-count-pill')
  })
})

describe('footer: settings sits below a hairline, set off from the categories', () => {
  test('the settings action emits on click semantics render (button present with the right label)', async () => {
    const html = await render()
    expect(html).toContain(t('nav.settings'))
    expect(html).toContain('class="wnr-settings"')
  })

  test('the footer carries a hairline above it', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('.wnr-footer {'),
      SOURCE.indexOf('.wnr-footer {') + 150,
    )
    expect(block).toContain('border-top: 1px solid var(--cs-line);')
  })
})

describe('rows carry no border: explicit, never a bare omission', () => {
  test('category and settings rows declare border: none', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.wnr-cat,'), SOURCE.indexOf('.wnr-cat:hover'))
    expect(block).toContain('border: none;')
  })

  test('no hex literal was introduced: every color is a --cs-* token', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
  })
})

describe('structure: brand header renders ahead of the categories', () => {
  test('the brand name and both categories are present, in that order', async () => {
    const html = await render()
    const brandAt = html.indexOf('codesema')
    const conversationsAt = html.indexOf(t('rail.conversations'))
    expect(brandAt).toBeGreaterThan(-1)
    expect(conversationsAt).toBeGreaterThan(brandAt)
  })
})
