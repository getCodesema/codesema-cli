// SSR string-render tests, same harness as QuickReplies.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { RecapCriterionVerdict } from '../../types'

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

type Props = { criteria?: RecapCriterionVerdict[] }

async function render(props: Props): Promise<string> {
  const CriteriaBlock = (await import('./CriteriaBlock.vue')).default
  const app = createSSRApp(CriteriaBlock, props)
  return renderToString(app)
}

describe('CriteriaBlock: absence is stated honestly, never a placeholder', () => {
  test('undefined criteria renders the "none" phrase', async () => {
    const html = await render({})
    expect(html).toContain(t('pilot.criteria.none'))
  })

  test('an empty criteria list renders the "none" phrase', async () => {
    const html = await render({ criteria: [] })
    expect(html).toContain(t('pilot.criteria.none'))
  })

  test('the title always renders, even absent', async () => {
    const html = await render({})
    expect(html).toContain(t('pilot.criteria.title'))
  })
})

describe('CriteriaBlock: one pastille per verdict, colored by status', () => {
  test('a met verdict carries the met status class', async () => {
    const html = await render({
      criteria: [{ criterion_id: 'ac-000000000001', status: 'met', text: 'the button ships' }],
    })
    expect(html).toContain('crb-dot--met')
    expect(html).toContain('the button ships')
  })

  test('an unmet verdict carries the unmet status class', async () => {
    const html = await render({
      criteria: [{ criterion_id: 'ac-000000000002', status: 'unmet', text: 'the API returns 404' }],
    })
    expect(html).toContain('crb-dot--unmet')
  })

  test('an unclear verdict carries the unclear status class', async () => {
    const html = await render({
      criteria: [{ criterion_id: 'ac-000000000003', status: 'unclear' }],
    })
    expect(html).toContain('crb-dot--unclear')
  })

  test('a verdict whose criterion text could not be resolved falls back to its raw id', async () => {
    const html = await render({
      criteria: [{ criterion_id: 'ac-000000000004', status: 'met' }],
    })
    expect(html).toContain('ac-000000000004')
  })

  test('several verdicts each render their own row', async () => {
    const html = await render({
      criteria: [
        { criterion_id: 'ac-1', status: 'met', text: 'one' },
        { criterion_id: 'ac-2', status: 'unmet', text: 'two' },
      ],
    })
    expect(html).toContain('one')
    expect(html).toContain('two')
    expect(html.match(/crb-row/g)?.length).toBe(2)
  })
})

describe('CriteriaBlock: a verdict carrying evidence shows it as a discreet line', () => {
  test('evidence renders under the criterion, prefixed by the evidence label', async () => {
    const html = await render({
      criteria: [
        {
          criterion_id: 'ac-000000000005',
          status: 'met',
          text: 'the retry button appears',
          evidence: 'diff adds a retry button in TaskConversation.vue line 412',
        },
      ],
    })
    expect(html).toContain(`${t('pilot.criteria.evidence')}:`)
    expect(html).toContain('diff adds a retry button in TaskConversation.vue line 412')
  })

  test('no evidence line renders when the verdict carries none', async () => {
    const html = await render({
      criteria: [{ criterion_id: 'ac-000000000006', status: 'unmet', text: 'the API returns 404' }],
    })
    expect(html).not.toContain(t('pilot.criteria.evidence'))
  })
})

describe('CriteriaBlock: no hex color literal in its scoped style', () => {
  test('every color comes from a --cs- token', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./CriteriaBlock.vue', import.meta.url)),
      'utf-8',
    )
    const style = source.slice(source.indexOf('<style'))
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
