// SSR string-render tests, same harness as QuickReplies.test.ts. Click
// handlers (`emit('pick', …)`, `emit('other')`) are not observable here since
// `renderToString` never triggers a DOM event — this file only checks the
// markup a given prop bag renders, including the nested QuickReplies markup.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

type Props = { question: string | null; options: string[]; disabled?: boolean }

async function render(props: Props): Promise<string> {
  const QuestionBlock = (await import('./QuestionBlock.vue')).default
  const app = createSSRApp(QuestionBlock, props)
  return renderToString(app)
}

describe('QuestionBlock: renders nothing without a pending question', () => {
  test('a null question renders no markup at all', async () => {
    const html = await render({ question: null, options: [] })
    expect(html.trim()).toBe('<!--v-if-->')
  })
})

describe('QuestionBlock: a pending question shows the amber banner, the question, and the replies', () => {
  test('the waiting banner and the question text both render', async () => {
    const html = await render({ question: 'Which branch should this target?', options: [] })
    expect(html).toContain(t('pilot.question.waiting'))
    expect(html).toContain('Which branch should this target?')
  })

  test('quick reply options render as buttons', async () => {
    const html = await render({ question: 'Pick one', options: ['main', 'develop'] })
    expect(html).toContain('→ main')
    expect(html).toContain('→ develop')
    expect(html).toContain(t('workspace.quickReplyOther'))
  })

  test('disabled reaches the nested QuickReplies option buttons', async () => {
    const html = await render({ question: 'Pick one', options: ['A'], disabled: true })
    const match = html.match(/<button[^>]*class="qr-opt"[^>]*>/)
    expect(match).not.toBeNull()
    expect(match?.[0]).toContain('disabled')
  })
})

describe('QuestionBlock: no hex color literal in its scoped style', () => {
  test('every color comes from a --cs- token', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./QuestionBlock.vue', import.meta.url)),
      'utf-8',
    )
    const style = source.slice(source.indexOf('<style'))
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
