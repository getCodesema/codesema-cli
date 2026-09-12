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
// own source, the same technique styles.test.ts uses.
describe('TaskEventUser is a right-aligned chat bubble on its own row', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./TaskEventUser.vue', import.meta.url)),
    'utf-8',
  )
  const style = source.slice(source.indexOf('<style'))
  const kit = readFileSync(fileURLToPath(new URL('../../styles/kit.css', import.meta.url)), 'utf-8')
  const kitUser = () => {
    const start = kit.indexOf('.msg.user {')
    return kit.slice(start, kit.indexOf('.msg.live', start))
  }
  const kitUserBody = () => {
    const start = kit.indexOf('.msg.user .body {')
    return kit.slice(start, kit.indexOf('}', start))
  }
  const bubbleRule = () => {
    const start = style.indexOf('.tvu-root .tvu-bubble {')
    return style.slice(start, style.indexOf('}', start))
  }

  test('the component invents no surface of its own', () => {
    expect(bubbleRule()).not.toContain('background')
    expect(bubbleRule()).not.toContain('border: 1px solid')
  })

  test('the kit fills the user prompt, and rails it no more', () => {
    expect(kitUserBody()).toContain('background: var(--bg-bubble);')
    expect(kitUserBody()).toContain('padding: 10px 16px;')
    // Explicit border: 0 is fine; a visible outline/box is not.
    expect(kitUserBody()).not.toMatch(/border:\s*1px/)
    expect(kitUserBody()).not.toContain('outline: 1px')
  })

  test('the kit pushes the whole user row to the right', () => {
    expect(kitUser()).toContain('align-items: flex-end;')
    expect(kitUser()).toContain('display: flex;')
  })

  test('no rail anywhere in the component either', () => {
    expect(style).not.toContain('border-left')
  })

  test('user bubble uses the kit bubble radius, component stays square', () => {
    expect(style).not.toContain('border-radius')
    expect(kitUserBody()).toContain('border-radius: var(--radius-bubble);')
    expect(kitUserBody()).toContain('background: var(--bg-bubble);')
  })

  test('the filled block comes from the kit message grammar', () => {
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'))
    expect(template).toContain('class="tvu-root msg user"')
    expect(template).toContain('class="tvu-block body"')
    expect(template).toContain('class="tvu-bubble tvu-md md"')
  })

  test('the stamp sits under the bubble, in the kit timestamp class', () => {
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'))
    expect(template).toContain('class="tvu-time ts"')
  })

  test('no speaker gutter: the bubble alone carries the dissymmetry', () => {
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'))
    expect(template).not.toContain('tvu-who')
    expect(template).not.toContain("t('conversation.you')")
  })

  test('width capped in characters', () => {
    expect(style).toContain('max-width: 60%;')
    expect(kitUserBody()).toContain('max-width: 60%;')
  })

  test('the bubble pins neither a size nor a line height: both inherit the kit', () => {
    const bubble = bubbleRule()
    expect(bubble).not.toContain('font-size')
    expect(bubble).not.toContain('line-height')
    expect(style).not.toMatch(/line-height: \d+px;/)
  })

  test('no hex literal and no raw rgba: theme tokens only', () => {
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(style).not.toContain('rgba(')
  })

  test('right-aligned via the kit, and no avatar element anywhere in the template', () => {
    expect(kitUser()).toContain('align-items: flex-end;')
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'))
    expect(template).not.toMatch(/avatar/i)
    expect(template).not.toContain('<img')
  })

  test('inline code is never coloured by this component', () => {
    expect(style).not.toContain('var(--ok)')
  })
})
