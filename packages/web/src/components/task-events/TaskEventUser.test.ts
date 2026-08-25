// Harness mirrors MrCard.test.ts / TaskConversation.test.ts: Bun's built-in
// `.vue` loader drops the template, so `vue/compiler-sfc` recompiles the SFC
// with the template inlined and `vue/server-renderer` renders it to a
// string. No DOM, no timers.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

async function renderUser(text: string): Promise<string> {
  const TaskEventUser = (await import('./TaskEventUser.vue')).default
  const app = createSSRApp(TaskEventUser, { text })
  return renderToString(app)
}

describe('TaskEventUser renders markdown, not raw text (the bug this component fixes)', () => {
  test('plain text renders as a paragraph', async () => {
    const html = await renderUser('just a sentence')
    expect(html).toContain('<p>just a sentence</p>')
  })

  // Today (before this component) the prompt is interpolated as raw text
  // inline in TaskConversation.vue: a bulleted list the user typed shows up
  // as literal "- one\n- two" instead of an actual list, while the
  // assistant's own replies render properly formatted. This is the concrete
  // regression guard for that gap.
  test('a bulleted list renders as an actual <ul>, not literal dashes', async () => {
    const html = await renderUser('- one\n- two')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
    expect(html).not.toContain('- one')
  })

  test('a fenced code block renders as <pre><code>, not literal backticks', async () => {
    const html = await renderUser('```\nconst x = 1\n```')
    expect(html).toContain('<pre><code>const x = 1</code></pre>')
    expect(html).not.toContain('```')
  })

  test('inline code renders as <code>', async () => {
    const html = await renderUser('run `bun test` first')
    expect(html).toContain('<code>bun test</code>')
  })

  test('bold and italic render as <strong>/<em>', async () => {
    const html = await renderUser('**bold** and *italic*')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })
})

// The user's own text is adversarial input by nature (unlike the agent's),
// so this is worth its own explicit guard rather than trusting the shared
// markdown.ts tests alone: renderMarkdown escapes BEFORE it transforms, so
// no raw tag and no non-http(s) link scheme can ever survive into v-html.
describe('TaskEventUser stays safe on adversarial user text', () => {
  test('a literal <script> tag is escaped, never rendered as an element', async () => {
    const html = await renderUser('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('an inline HTML event handler is escaped, never rendered as an attribute', async () => {
    const html = await renderUser('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('a javascript: URI never becomes a clickable link', async () => {
    const html = await renderUser('[click me](javascript:alert(1))')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href="javascript:')
  })

  test('an http(s) link still renders as a real, safe anchor', async () => {
    const html = await renderUser('[docs](https://example.test/x)')
    expect(html).toContain('<a href="https://example.test/x" target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

// Geometry cannot be read back from server-rendered HTML text (scoped
// <style> never reaches the SSR string), so the exact measures the brief
// specifies — fiche 12 section 2 — are checked directly on the component's
// own source, the same technique style.test.ts uses for style.css.
describe('TaskEventUser geometry matches fiche 12 section 2, exactly', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./TaskEventUser.vue', import.meta.url)),
    'utf-8',
  )
  const style = source.slice(source.indexOf('<style'))

  test('surface background, not the old green-tinted one', () => {
    expect(style).toContain('background: var(--cs-surface);')
    expect(style).not.toContain('--cs-green-soft')
  })

  test('16px uniform radius, not the old asymmetric 10/10/3/10 one', () => {
    expect(style).toContain('border-radius: 16px;')
  })

  test('16px horizontal / 8px vertical padding ("16 px sur 8 px")', () => {
    expect(style).toContain('padding: 8px 16px;')
  })

  test('550px max width, fitted to content', () => {
    expect(style).toContain('max-width: 550px;')
    expect(style).toContain('width: fit-content;')
  })

  test('14px body on a 24px line height ("corps 14/24 px")', () => {
    expect(style).toContain('font-size: 14px;')
    expect(style).toContain('line-height: 24px;')
  })

  test('right-aligned, and no avatar element anywhere in the template', () => {
    expect(style).toContain('align-self: flex-end;')
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'))
    expect(template).not.toMatch(/avatar/i)
    expect(template).not.toContain('<img')
  })
})
