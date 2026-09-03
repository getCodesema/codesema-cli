// SSR string-render tests, same harness as Lens.test.ts: the viewer teleports
// to body, so its markup is read from the render context's teleports. Wheel,
// drag and keyboard zoom are DOM-only and covered by MediaViewerLogic.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { EvidenceKind } from '../../types'

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

type Props = { src: string; kind: EvidenceKind; caption: string }

async function render(props: Props): Promise<{ main: string; teleported: string }> {
  const MediaViewer = (await import('./MediaViewer.vue')).default
  const app = createSSRApp({ render: () => h(MediaViewer, props) })
  const ctx: Record<string, unknown> = {}
  const main = await renderToString(app, ctx)
  const teleported = (ctx.teleports as Record<string, string> | undefined)?.body ?? ''
  return { main, teleported }
}

const shot: Props = {
  src: '/api/tasks/t1/evidence/a.png?project=p',
  kind: 'screenshot',
  caption: 'turn 1',
}
const clip: Props = {
  src: '/api/tasks/t1/evidence/a.webm?project=p',
  kind: 'video',
  caption: 'Video · turn 1',
}

describe('MediaViewer: teleports to body', () => {
  test('the main tree carries only the teleport anchor', async () => {
    const { main } = await render(shot)
    expect(main).toContain('teleport')
    expect(main).not.toContain('mv-root')
  })
})

describe('MediaViewer: media and chrome', () => {
  test('a screenshot renders an <img> at fit with the caption and the zoom controls', async () => {
    const { teleported } = await render(shot)
    expect(teleported).toContain('<img')
    expect(teleported).toContain(`src="${shot.src}"`)
    expect(teleported).toContain('turn 1')
    expect(teleported).toContain('scale(1)')
    expect(teleported).toContain('100 %')
    expect(teleported).toContain(t('pilot.media.close'))
    expect(teleported).toContain(t('pilot.media.zoomIn'))
    expect(teleported).toContain(t('pilot.media.zoomOut'))
    expect(teleported).toContain(t('pilot.media.reset'))
    expect(teleported).not.toContain('<video')
  })

  test('a video renders a <video controls autoplay> and no <img>', async () => {
    const { teleported } = await render(clip)
    expect(teleported).toContain('<video')
    expect(teleported).toContain('controls')
    expect(teleported).toContain('autoplay')
    expect(teleported).toContain(`src="${clip.src}"`)
    expect(teleported).not.toContain('<img')
  })

  test('at fit, zoom out and reset are disabled', async () => {
    const { teleported } = await render(shot)
    const zoomOut = teleported.slice(teleported.indexOf(t('pilot.media.zoomOut')) - 200)
    expect(zoomOut).toContain('disabled')
  })
})

describe('MediaViewer: dialog semantics', () => {
  test('role=dialog, aria-modal=true and the aria label are present', async () => {
    const { teleported } = await render(shot)
    expect(teleported).toContain('role="dialog"')
    expect(teleported).toContain('aria-modal="true"')
    expect(teleported).toContain(`aria-label="${t('pilot.media.aria')}"`)
  })
})

describe('MediaViewer: no hardcoded color leaks into the component', () => {
  test('the scoped style block uses only --cs- tokens, no hex literal', () => {
    const source = readFileSync(new URL('./MediaViewer.vue', import.meta.url), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
