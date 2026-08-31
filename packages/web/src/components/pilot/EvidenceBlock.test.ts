// SSR string-render tests, same harness as QuickReplies.test.ts: Bun's
// built-in `.vue` loader drops the template, so `vue/compiler-sfc` recompiles
// the SFC with the template inlined and `vue/server-renderer` renders it to a
// string. No DOM, no timers, no click handlers observable here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { EvidenceRecord } from '../../types'

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

type Props = { taskId: string; evidence?: EvidenceRecord | null }

async function render(props: Props): Promise<string> {
  const EvidenceBlock = (await import('./EvidenceBlock.vue')).default
  const app = createSSRApp(EvidenceBlock, props)
  return renderToString(app)
}

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    version: 1,
    status: 'passed',
    reason: null,
    head_sha: 'abc1234',
    items: [],
    ...overrides,
  }
}

describe('EvidenceBlock: absence is stated honestly, never a placeholder', () => {
  test('undefined evidence renders the "none" phrase', async () => {
    const html = await render({ taskId: 'task-1' })
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('null evidence renders the "none" phrase', async () => {
    const html = await render({ taskId: 'task-1', evidence: null })
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('an evidence record with an empty items list renders the "none" phrase', async () => {
    const html = await render({ taskId: 'task-1', evidence: record({ items: [] }) })
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('the title always renders, even absent', async () => {
    const html = await render({ taskId: 'task-1', evidence: null })
    expect(html).toContain(t('pilot.evidence.title'))
  })
})

describe('EvidenceBlock: a failed run surfaces its reason, even with nothing captured', () => {
  test('status "failed" shows the failed banner and the reason text', async () => {
    const html = await render({
      taskId: 'task-1',
      evidence: record({ status: 'failed', reason: 'the click never landed', items: [] }),
    })
    expect(html).toContain(t('pilot.evidence.failed'))
    expect(html).toContain('the click never landed')
    // Zero items alongside a failure still says so honestly: the reason is
    // not hidden behind the "no evidence yet" branch.
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('a passed run never shows the failed banner', async () => {
    const html = await render({
      taskId: 'task-1',
      evidence: record({ status: 'passed', items: [] }),
    })
    expect(html).not.toContain(t('pilot.evidence.failed'))
  })

  test('a null reason on a failed run shows the banner with no reason text appended', async () => {
    const html = await render({
      taskId: 'task-1',
      evidence: record({ status: 'failed', reason: null }),
    })
    expect(html).toContain(t('pilot.evidence.failed'))
  })
})

describe('EvidenceBlock: items render as media, URL-encoded, labeled by turn', () => {
  test('a screenshot renders an <img> with the encoded file URL and alt text', async () => {
    const html = await render({
      taskId: 'task 1',
      evidence: record({
        items: [
          { kind: 'screenshot', path: 'shots/turn 2.png', bytes: 100, turn: 2, created_at: 'now' },
        ],
      }),
    })
    expect(html).toContain('<img')
    expect(html).toContain('src="/api/tasks/task%201/evidence/shots%2Fturn%202.png"')
    expect(html).toContain(t('pilot.evidence.screenshotAlt'))
    expect(html).toContain(t('pilot.evidence.turn', { n: 2 }))
  })

  test('a video renders a <video controls preload="metadata"> with the same URL scheme, plus the video label', async () => {
    const html = await render({
      taskId: 'task-1',
      evidence: record({
        items: [{ kind: 'video', path: 'clip.mp4', bytes: 999, turn: 5, created_at: 'now' }],
      }),
    })
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('src="/api/tasks/task-1/evidence/clip.mp4"')
    expect(html).toContain(t('pilot.evidence.videoLabel'))
    expect(html).toContain(t('pilot.evidence.turn', { n: 5 }))
    expect(html).not.toContain('<img')
  })

  test('a failed run with captured items shows both the banner and the items', async () => {
    const html = await render({
      taskId: 'task-1',
      evidence: record({
        status: 'failed',
        reason: 'crashed after the second screenshot',
        items: [{ kind: 'screenshot', path: 'a.png', bytes: 1, turn: 1, created_at: 'now' }],
      }),
    })
    expect(html).toContain(t('pilot.evidence.failed'))
    expect(html).toContain('crashed after the second screenshot')
    expect(html).toContain('<img')
    expect(html).not.toContain(t('pilot.evidence.none'))
  })
})

describe('EvidenceBlock: no hex color literal in its scoped style', () => {
  test('every color comes from a --cs- token', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./EvidenceBlock.vue', import.meta.url)),
      'utf-8',
    )
    const style = source.slice(source.indexOf('<style'))
    expect(style.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull()
  })
})
