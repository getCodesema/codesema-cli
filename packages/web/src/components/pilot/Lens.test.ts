// SSR string-render tests, same harness as QuickReplies.test.ts. Lens teleports
// its markup to <body>, so renderToString alone (main app string) never carries
// it: an SSRContext is passed and read back from context.teleports.body, the
// documented way to observe Vue Teleport output server-side. Click handlers and
// the document keydown/focus wiring are not observable in SSR (no real DOM
// events fire against renderToString): PilotLogic.onEscape already covers the
// Escape state transition on its own, and the rest (listener add/remove on
// mount/unmount, close button focus) is left unverified here.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
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
  title: string
}

async function render(props: Props): Promise<{ main: string; teleported: string }> {
  const Lens = (await import('./Lens.vue')).default
  const app = createSSRApp({
    render: () =>
      h(Lens, props, { default: () => h('div', { class: 'stub-block' }, 'STUB CONTENT') }),
  })
  const ctx: Record<string, unknown> = {}
  const main = await renderToString(app, ctx)
  const teleported = (ctx.teleports as Record<string, string> | undefined)?.body ?? ''
  return { main, teleported }
}

describe('Lens: teleports to body, never inline in the main app markup', () => {
  test('the main app tree carries only the teleport anchors', async () => {
    const { main } = await render({ title: 'My task' })
    expect(main).toContain('teleport')
    expect(main).not.toContain('pl-lens')
  })
})

describe('Lens: bar and slot content', () => {
  test('the title and the close button both render', async () => {
    const { teleported } = await render({ title: 'My task' })
    expect(teleported).toContain('My task')
    expect(teleported).toContain(t('pilot.lens.close'))
  })

  test('the slotted content renders inside the lens, not duplicated', async () => {
    const { teleported } = await render({ title: 'My task' })
    expect(teleported).toContain('STUB CONTENT')
    expect([...teleported.matchAll(/STUB CONTENT/g)]).toHaveLength(1)
  })
})

describe('Lens: dialog semantics', () => {
  test('role=dialog, aria-modal=true and the aria label are present', async () => {
    const { teleported } = await render({ title: 'My task' })
    expect(teleported).toContain('role="dialog"')
    expect(teleported).toContain('aria-modal="true"')
    expect(teleported).toContain(`aria-label="${t('pilot.lens.aria')}"`)
  })
})

describe('Lens: no hardcoded color leaks into the component', () => {
  test('the scoped style block uses only --cs- tokens, no hex literal', () => {
    const source = readFileSync(new URL('./Lens.vue', import.meta.url), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(styleBlock).not.toMatch(/animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/)
  })
})
