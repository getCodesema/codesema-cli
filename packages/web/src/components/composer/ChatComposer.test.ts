// SSR string-render tests: the auto-grow math, the drag/keyboard resize and
// the double-click reset all depend on the DOM (scrollHeight, pointer
// events) and are therefore NOT observable here: they are covered directly
// and exhaustively in ComposerLogic.test.ts. This file only checks the
// markup a given prop bag renders: initial classes, the placeholder text
// (including its state-priority ordering), and which buttons are disabled.
// Same harness as ForgeSplitter.test.ts.
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
  modelValue: string
  placeholder: string
  mode?: 'clean' | 'temporary' | 'private'
  sending?: boolean
  offline?: boolean
  stopping?: boolean
  dictating?: boolean
  transcribing?: boolean
  bannersHeight?: number
}

async function render(props: Props): Promise<string> {
  const ChatComposer = (await import('./ChatComposer.vue')).default
  const app = createSSRApp(ChatComposer, props)
  return renderToString(app)
}

/** The opening tag of the first element containing `marker`, so an assertion
 * on one button (e.g. `class="cc-send"`) can never accidentally match another
 * one further down the same markup string. */
function openingTag(html: string, marker: string): string {
  const idx = html.indexOf(marker)
  if (idx === -1) {
    throw new Error(`marker not found in rendered html: ${marker}`)
  }
  const start = html.lastIndexOf('<', idx)
  const end = html.indexOf('>', idx)
  return html.slice(start, end + 1)
}

const BASE: Props = { modelValue: '', placeholder: 'Describe a task…' }

describe('ChatComposer: structure', () => {
  test('renders the resize handle as a focusable horizontal ARIA separator', async () => {
    const html = await render(BASE)
    const tag = openingTag(html, 'role="separator"')
    expect(tag).toContain('aria-orientation="horizontal"')
    expect(tag).toContain('tabindex="0"')
    expect(tag).toContain(`aria-label="${t('composer.resizeHandleAria')}"`)
  })

  test('renders the textarea with the current value as its content', async () => {
    const html = await render({ ...BASE, modelValue: 'fix the flaky test' })
    expect(html).toContain('<textarea')
    expect(html).toContain('>fix the flaky test</textarea>')
  })

  test('renders the send button, the attach button, and the two inert placeholder tools', async () => {
    const html = await render(BASE)
    expect(html).toContain('class="cc-send"')
    expect(html).toContain('cc-tool--attach')
    expect(html).toContain('cc-tool--placeholder')
  })
})

describe('ChatComposer: placeholder is a state display (fiche section 2)', () => {
  test("default: the caller's message, then the shortcuts in parens", async () => {
    const html = await render({ ...BASE, placeholder: 'Answer the agent…' })
    expect(html).toContain(`placeholder="Answer the agent… ${t('composer.hintShortcuts')}"`)
  })

  test('offline replaces the placeholder entirely', async () => {
    const html = await render({ ...BASE, offline: true })
    expect(html).toContain(`placeholder="${t('composer.hintOffline')}"`)
    expect(html).not.toContain(BASE.placeholder)
  })

  test('offline wins over every other simultaneous state', async () => {
    const html = await render({
      ...BASE,
      offline: true,
      stopping: true,
      dictating: true,
      transcribing: true,
    })
    expect(html).toContain(`placeholder="${t('composer.hintOffline')}"`)
  })

  test('stopping wins over dictating and transcribing', async () => {
    const html = await render({ ...BASE, stopping: true, dictating: true, transcribing: true })
    expect(html).toContain(`placeholder="${t('composer.hintStopping')}"`)
  })

  test('dictating wins over transcribing', async () => {
    const html = await render({ ...BASE, dictating: true, transcribing: true })
    expect(html).toContain(`placeholder="${t('composer.hintDictating')}"`)
  })

  test('transcribing alone', async () => {
    const html = await render({ ...BASE, transcribing: true })
    expect(html).toContain(`placeholder="${t('composer.hintTranscribing')}"`)
  })
})

describe('ChatComposer: mode carries the filet color (fiche section 1)', () => {
  test('clean mode adds neither modifier class', async () => {
    const html = await render({ ...BASE, mode: 'clean' })
    expect(html).not.toContain('cc-root--temporary')
    expect(html).not.toContain('cc-root--private')
  })

  test('temporary mode marks the root', async () => {
    const html = await render({ ...BASE, mode: 'temporary' })
    expect(html).toContain('cc-root--temporary')
    expect(html).not.toContain('cc-root--private')
  })

  test('private mode marks the root', async () => {
    const html = await render({ ...BASE, mode: 'private' })
    expect(html).toContain('cc-root--private')
    expect(html).not.toContain('cc-root--temporary')
  })
})

describe('ChatComposer: the round send button (fiche section 3)', () => {
  test('disabled with empty text', async () => {
    const html = await render({ ...BASE, modelValue: '' })
    expect(openingTag(html, 'class="cc-send"')).toContain('disabled')
  })

  test('disabled with whitespace-only text', async () => {
    const html = await render({ ...BASE, modelValue: '   ' })
    expect(openingTag(html, 'class="cc-send"')).toContain('disabled')
  })

  test('enabled with real text and nothing in flight', async () => {
    const html = await render({ ...BASE, modelValue: 'ship it' })
    expect(openingTag(html, 'class="cc-send"')).not.toContain('disabled')
  })

  test('disabled while a send is already in flight, even with text', async () => {
    const html = await render({ ...BASE, modelValue: 'ship it', sending: true })
    expect(openingTag(html, 'class="cc-send"')).toContain('disabled')
  })

  test('carries the send aria-label', async () => {
    const html = await render(BASE)
    expect(openingTag(html, 'class="cc-send"')).toContain(`aria-label="${t('composer.sendAria')}"`)
  })
})

describe('ChatComposer: toolbar placeholders stay inert (fiche section 7.3)', () => {
  test('the attach button starts closed, not rotated', async () => {
    const html = await render(BASE)
    const tag = openingTag(html, 'cc-tool--attach')
    expect(tag).toContain('aria-expanded="false"')
    expect(tag).not.toContain('cc-tool--open')
  })

  test('dictation and text-improvement buttons are disabled placeholders', async () => {
    const html = await render(BASE)
    const buttons = [...html.matchAll(/<button[^>]*cc-tool--placeholder[^>]*>/g)].map((m) => m[0])
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toContain('disabled')
    }
  })

  test('their aria-labels say what they are, in the language of the rest of the box', async () => {
    const html = await render(BASE)
    expect(html).toContain(t('composer.micAria'))
    expect(html).toContain(t('composer.improveAria'))
  })
})
