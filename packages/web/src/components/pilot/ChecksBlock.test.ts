// SSR string-render tests, same harness as QuickReplies.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { TaskChecks } from '../../types'

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

type Props = { checks?: TaskChecks | null }

async function render(props: Props): Promise<string> {
  const ChecksBlock = (await import('./ChecksBlock.vue')).default
  const app = createSSRApp(ChecksBlock, props)
  return renderToString(app)
}

function record(overrides: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'abc1234',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [],
    error: null,
    ...overrides,
  }
}

describe('ChecksBlock: absence renders the existing neutral phrase, nothing invented', () => {
  test('undefined checks renders "no checks have run yet"', async () => {
    const html = await render({})
    expect(html).toContain(t('workspace.checksNeverRan'))
  })

  test('null checks renders "no checks have run yet"', async () => {
    const html = await render({ checks: null })
    expect(html).toContain(t('workspace.checksNeverRan'))
  })

  test('the title always renders, even absent', async () => {
    const html = await render({ checks: null })
    expect(html).toContain(t('pilot.checks.title'))
  })
})

describe('ChecksBlock: the overall verdict and one row per check', () => {
  test('a passed run shows the passed verdict', async () => {
    const html = await render({ checks: record({ status: 'passed' }) })
    expect(html).toContain(t('workspace.checksStatusPassed'))
  })

  test('a failed run shows the failed verdict', async () => {
    const html = await render({ checks: record({ status: 'failed' }) })
    expect(html).toContain(t('workspace.checksStatusFailed'))
  })

  test('each check renders its command, glyph and localized status word', async () => {
    const html = await render({
      checks: record({
        status: 'failed',
        checks: [
          {
            command: 'bun run typecheck',
            status: 'passed',
            exit_code: 0,
            duration_ms: 100,
            tail: '',
          },
          { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 200, tail: '' },
        ],
      }),
    })
    expect(html).toContain('bun run typecheck')
    expect(html).toContain('bun test')
    expect(html).toContain(t('workspace.checkPassed'))
    expect(html).toContain(t('workspace.checkFailed'))
  })

  test('no check rows render when the checks list is empty', async () => {
    const html = await render({ checks: record({ status: 'unconfigured', checks: [] }) })
    expect(html).not.toContain('ckb-row')
    expect(html).toContain(t('workspace.checksStatusUnconfigured'))
  })
})

describe('ChecksBlock: no hex color literal in its scoped style', () => {
  test('every color comes from a --cs- token', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ChecksBlock.vue', import.meta.url)),
      'utf-8',
    )
    const style = source.slice(source.indexOf('<style'))
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
