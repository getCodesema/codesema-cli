// Harness mirrors MrCard.test.ts / TaskConversation.test.ts: Bun's built-in
// `.vue` loader drops the template, so `vue/compiler-sfc` recompiles the SFC
// with the template inlined and `vue/server-renderer` renders it to a
// string. No DOM, no timers — which is why the 1200ms "still active" TIMEOUT
// TRANSITION itself is not exercised here: this harness renders once,
// synchronously, to a string (see TaskConversation.test.ts's own docstring).
// What IS covered is every state reachable from a single render: the two
// `streaming` values at mount, and the two `open` values as the caller's own
// controlled prop (see the component's doc comment on why `open` is a prop
// rather than an internal ref).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import { previewTail, THINKING_IDLE_MS, THINKING_PREVIEW_CHARS } from './TaskEventThinking'

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

type ThinkingProps = { text: string; open: boolean; streaming?: boolean }

async function renderThinking(props: ThinkingProps): Promise<string> {
  const TaskEventThinking = (await import('./TaskEventThinking.vue')).default
  const app = createSSRApp(TaskEventThinking, props)
  return renderToString(app)
}

describe('previewTail (fiche 12 section 3: the last 240 characters, never more)', () => {
  test('fiche constants: the window is 240 characters, the idle threshold 1200ms', () => {
    expect(THINKING_PREVIEW_CHARS).toBe(240)
    expect(THINKING_IDLE_MS).toBe(1200)
  })

  test('text within the window: returned whole, not truncated', () => {
    expect(previewTail('short')).toEqual({ text: 'short', truncated: false })
  })

  test('text exactly at the window boundary: not truncated', () => {
    const text = 'x'.repeat(240)
    expect(previewTail(text)).toEqual({ text, truncated: false })
  })

  test('text one character past the boundary: truncated to exactly 240, keeping the TAIL', () => {
    const text = `${'a'.repeat(200)}${'b'.repeat(41)}`
    const result = previewTail(text)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(240)
    // Exactly one 'a' (the very first character) is what got cut.
    expect(result.text).toBe(`${'a'.repeat(199)}${'b'.repeat(41)}`)
  })

  test('a custom window size is honored', () => {
    expect(previewTail('abcdef', 3)).toEqual({ text: 'def', truncated: true })
  })

  test('empty text: not truncated, empty preview', () => {
    expect(previewTail('')).toEqual({ text: '', truncated: false })
  })
})

describe('TaskEventThinking folded (open=false): the tail preview', () => {
  test('short text renders whole, with no fade', async () => {
    const html = await renderThinking({ text: 'still forming a thought', open: false })
    expect(html).toContain('still forming a thought')
    expect(html).not.toContain('tvth-preview--faded')
    expect(html).not.toContain('tvth-body')
  })

  test('long text renders only its last 240 characters, with the fade class', async () => {
    // A one-off head marker followed by enough filler that the cutoff (at
    // length-240) falls well past it, then a tail marker at the very end.
    const head = 'HEAD_MARKER_ONLY_ONCE'
    const filler = 'x'.repeat(260)
    const tail = 'TAIL_MARKER_ONLY_ONCE'
    const text = head + filler + tail
    const html = await renderThinking({ text, open: false })
    expect(html).toContain(tail)
    expect(html).not.toContain(head)
    expect(html).toContain('tvth-preview--faded')
  })

  test('empty text renders neither the preview line nor the body', async () => {
    const html = await renderThinking({ text: '', open: false })
    expect(html).not.toContain('tvth-preview"')
    expect(html).not.toContain('tvth-body')
  })

  test('folded: aria-expanded is false and the chevron carries no open class', async () => {
    const html = await renderThinking({ text: 'x', open: false })
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('tvth-chevron--open')
  })
})

describe('TaskEventThinking unfolded (open=true): the whole prose, capped', () => {
  test('the full text renders, not just the 240-character tail', async () => {
    const head = 'HEAD'.repeat(100)
    const text = `${head}TAIL`
    const html = await renderThinking({ text, open: true })
    expect(html).toContain(head)
    expect(html).toContain('TAIL')
  })

  test('open: aria-expanded is true and the chevron carries the open class', async () => {
    const html = await renderThinking({ text: 'x', open: true })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('tvth-chevron--open')
  })

  test('open hides the folded preview entirely', async () => {
    const html = await renderThinking({ text: 'x'.repeat(300), open: true })
    expect(html).not.toContain('tvth-preview"')
  })
})

describe('TaskEventThinking activity dot', () => {
  test('streaming=true shows the live dot at first render', async () => {
    const html = await renderThinking({ text: 'x', open: false, streaming: true })
    expect(html).toContain('tvth-dot')
  })

  test('streaming omitted shows no live dot', async () => {
    const html = await renderThinking({ text: 'x', open: false })
    expect(html).not.toContain('tvth-dot')
  })

  test('streaming=false explicitly shows no live dot', async () => {
    const html = await renderThinking({ text: 'x', open: false, streaming: false })
    expect(html).not.toContain('tvth-dot')
  })
})

describe('TaskEventThinking chrome', () => {
  test('the label is translated, not hard-coded English in a French build', async () => {
    const html = await renderThinking({ text: 'x', open: false })
    expect(html).toContain(t('workspace.evThinking'))
  })

  test('carries the brain and chevron glyphs, by their stable lucide classes', async () => {
    const html = await renderThinking({ text: 'x', open: false })
    expect(html).toContain('lucide-brain')
    expect(html).toContain('lucide-chevron-right')
  })
})

// Geometry cannot be read back from server-rendered HTML text (scoped
// <style> never reaches the SSR string), so the exact measures the brief
// specifies — fiche 12 section 3 — are checked directly on the component's
// own source, the same technique style.test.ts uses for style.css.
describe('TaskEventThinking geometry matches fiche 12 section 3, exactly', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./TaskEventThinking.vue', import.meta.url)),
    'utf-8',
  )
  const style = source.slice(source.indexOf('<style'))

  test("the pilule's own padding and radius (8px sur 2px, rayon 8px)", () => {
    expect(style).toContain('padding: 2px 8px;')
    expect(style).toContain('border-radius: 8px;')
  })

  test('the chevron pivots in 200ms — NOT EventCard’s 150ms, a different gabarit', () => {
    expect(style).toContain('transition: transform 200ms ease;')
  })

  test('the fade is 36px wide', () => {
    expect(style).toContain('36px')
  })

  test('the unfolded prose is capped at 65 characters per line', () => {
    expect(style).toContain('max-width: 65ch;')
  })

  test('the unfolded box scrolls, capped at 360px', () => {
    expect(style).toContain('max-height: 360px;')
    expect(style).toContain('overflow-y: auto;')
  })

  test('the folded line clips to its tail (direction: rtl), not its head', () => {
    expect(style).toContain('direction: rtl;')
    expect(style).toContain('unicode-bidi: plaintext;')
  })
})
