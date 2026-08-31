// SSR string-render tests, same harness as QuickReplies.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { RecapRecord } from '../../types'

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

type Props = { recap?: RecapRecord | null }

async function render(props: Props): Promise<string> {
  const RecapBlock = (await import('./RecapBlock.vue')).default
  const app = createSSRApp(RecapBlock, props)
  return renderToString(app)
}

function record(overrides: Partial<RecapRecord> = {}): RecapRecord {
  return {
    version: 1,
    summary: 'Did the thing.',
    changes: [],
    decisions: [],
    files: [],
    tests: [],
    branch: 'codesema/task-x',
    ...overrides,
  }
}

describe('RecapBlock: absence is stated honestly, never a placeholder', () => {
  test('undefined recap renders the pending phrase', async () => {
    const html = await render({})
    expect(html).toContain(t('pilot.recap.pending'))
  })

  test('null recap renders the pending phrase', async () => {
    const html = await render({ recap: null })
    expect(html).toContain(t('pilot.recap.pending'))
  })

  test('the title always renders, even pending', async () => {
    const html = await render({ recap: null })
    expect(html).toContain(t('pilot.recap.title'))
  })
})

describe('RecapBlock: the summary renders through renderMarkdown, safely', () => {
  test('markdown in the summary is transformed, not shown as raw sigils', async () => {
    const html = await render({ recap: record({ summary: '**bold** and a `code` span' }) })
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
  })

  test('adversarial summary text is escaped before v-html, never a raw tag', async () => {
    const html = await render({ recap: record({ summary: '<script>alert(1)</script>' }) })
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('RecapBlock: changes/decisions/files/tests render only when non-empty', () => {
  test('every section is absent when its list is empty', async () => {
    const html = await render({ recap: record() })
    expect(html).not.toContain(t('pilot.recap.changes'))
    expect(html).not.toContain(t('pilot.recap.decisions'))
    expect(html).not.toContain(t('pilot.recap.files'))
    expect(html).not.toContain(t('pilot.recap.tests'))
  })

  test('changes render as a list under its title', async () => {
    const html = await render({ recap: record({ changes: ['added the button', 'fixed the bug'] }) })
    expect(html).toContain(t('pilot.recap.changes'))
    expect(html).toContain('<li>added the button</li>')
    expect(html).toContain('<li>fixed the bug</li>')
  })

  test('decisions render as a list under its title', async () => {
    const html = await render({ recap: record({ decisions: ['used a Map for O(1) lookup'] }) })
    expect(html).toContain(t('pilot.recap.decisions'))
    expect(html).toContain('<li>used a Map for O(1) lookup</li>')
  })

  test('files render as a list under its title', async () => {
    const html = await render({ recap: record({ files: ['src/a.ts', 'src/b.ts'] }) })
    expect(html).toContain(t('pilot.recap.files'))
    expect(html).toContain('<li>src/a.ts</li>')
  })

  test('tests render command and status, mapped onto the shared check words', async () => {
    const html = await render({
      recap: record({
        tests: [
          { command: 'bun test', status: 'passed' },
          { command: 'unconfigured run', status: 'unconfigured', synthetic: true },
        ],
      }),
    })
    expect(html).toContain(t('pilot.recap.tests'))
    expect(html).toContain('bun test')
    expect(html).toContain(t('workspace.checkPassed'))
    expect(html).toContain(t('workspace.checksStatusUnconfigured'))
  })
})

describe('RecapBlock: no hex color literal in its scoped style', () => {
  test('every color comes from a --cs- token', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./RecapBlock.vue', import.meta.url)),
      'utf-8',
    )
    const style = source.slice(source.indexOf('<style'))
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
