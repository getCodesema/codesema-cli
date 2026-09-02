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
import type { EvidenceRecord, TaskVerification } from '../../types'

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
  projectId: string
  taskId: string
  evidence?: EvidenceRecord | null
  verification?: TaskVerification | null
  activity?: {
    phase: 'checks' | 'verification' | 'proof' | 'review' | 'recap'
    since: string
  } | null
}

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

function verificationRecord(overrides: Partial<TaskVerification> = {}): TaskVerification {
  return {
    head_sha: 'abc1234def',
    runbook_sha: '0123456789abcdef',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [],
    integrity_ok: true,
    changed_dependency_files: [],
    error: null,
    ...overrides,
  }
}

describe('EvidenceBlock: absence is stated honestly, never a placeholder', () => {
  test('undefined evidence renders the "none" phrase', async () => {
    const html = await render({ projectId: 'proj-a', taskId: 'task-1' })
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('null evidence renders the "none" phrase', async () => {
    const html = await render({ projectId: 'proj-a', taskId: 'task-1', evidence: null })
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('an evidence record with an empty items list renders the "none" phrase', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({ items: [] }),
    })
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('the title always renders, even absent', async () => {
    const html = await render({ projectId: 'proj-a', taskId: 'task-1', evidence: null })
    expect(html).toContain(t('pilot.evidence.title'))
  })
})

describe('EvidenceBlock: the running-phase line replaces "none" while capturing', () => {
  test('proof phase with no items and no verification shows the running glyph and the phase phrase, not the "none" phrase', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      activity: { phase: 'proof', since: '2026-08-14T10:00:00.000Z' },
    })
    expect(html).toContain(t('pilot.activity.proof'))
    expect(html).not.toContain(t('pilot.evidence.none'))
  })

  test('verification phase with no items and no verification also shows the running line', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      activity: { phase: 'verification', since: '2026-08-14T10:00:00.000Z' },
    })
    expect(html).toContain(t('pilot.activity.verification'))
    expect(html).not.toContain(t('pilot.evidence.none'))
  })

  test('a non-capture phase (recap) leaves the plain "none" phrase in place', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      activity: { phase: 'recap', since: '2026-08-14T10:00:00.000Z' },
    })
    expect(html).toContain(t('pilot.evidence.none'))
    expect(html).not.toContain(t('pilot.activity.recap'))
  })

  test('items already captured render normally even during a capture-phase activity', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        items: [{ kind: 'screenshot', path: 'a.png', bytes: 1, turn: 1, created_at: 'now' }],
      }),
      activity: { phase: 'proof', since: '2026-08-14T10:00:00.000Z' },
    })
    expect(html).toContain('<img')
    expect(html).not.toContain(t('pilot.activity.proof'))
    expect(html).not.toContain(t('pilot.evidence.none'))
  })

  test('a verification record already present takes priority over the running line', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({ status: 'passed' }),
      activity: { phase: 'proof', since: '2026-08-14T10:00:00.000Z' },
    })
    expect(html).toContain(t('pilot.evidence.none'))
    expect(html).not.toContain(t('pilot.activity.proof'))
  })
})

describe('EvidenceBlock: a failed run surfaces its reason, even with nothing captured', () => {
  test('status "failed" shows the failed banner and the reason text', async () => {
    const html = await render({
      projectId: 'proj-a',
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
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({ status: 'passed', items: [] }),
    })
    expect(html).not.toContain(t('pilot.evidence.failed'))
  })

  test('a null reason on a failed run shows the banner with no reason text appended', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({ status: 'failed', reason: null }),
    })
    expect(html).toContain(t('pilot.evidence.failed'))
  })
})

describe('EvidenceBlock: items render as media, URL-encoded, labeled by turn', () => {
  test('a screenshot renders an <img> with the encoded file URL and alt text', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task 1',
      evidence: record({
        items: [
          { kind: 'screenshot', path: 'shots/turn 2.png', bytes: 100, turn: 2, created_at: 'now' },
        ],
      }),
    })
    expect(html).toContain('<img')
    expect(html).toContain('src="/api/tasks/task%201/evidence/shots%2Fturn%202.png?project=proj-a"')
    expect(html).toContain(t('pilot.evidence.screenshotAlt'))
    expect(html).toContain(t('pilot.evidence.turn', { n: 2 }))
  })

  test('a video renders a <video controls preload="metadata"> with the same URL scheme, plus the video label', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        items: [{ kind: 'video', path: 'clip.mp4', bytes: 999, turn: 5, created_at: 'now' }],
      }),
    })
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('src="/api/tasks/task-1/evidence/clip.mp4?project=proj-a"')
    expect(html).toContain(t('pilot.evidence.videoLabel'))
    expect(html).toContain(t('pilot.evidence.turn', { n: 5 }))
    expect(html).not.toContain('<img')
  })

  test('a failed run with captured items shows both the banner and the items', async () => {
    const html = await render({
      projectId: 'proj-a',
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

describe('EvidenceBlock: the verification section is absent unless there is a real record', () => {
  test('undefined verification renders no verification section at all', async () => {
    const html = await render({ projectId: 'proj-a', taskId: 'task-1' })
    expect(html).not.toContain(t('pilot.verification.title'))
  })

  test('null verification renders no verification section at all', async () => {
    const html = await render({ projectId: 'proj-a', taskId: 'task-1', verification: null })
    expect(html).not.toContain(t('pilot.verification.title'))
  })

  test('a passed verification shows the title, the passed phrase and the verified head sha', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({ status: 'passed', head_sha: 'abc1234def' }),
    })
    expect(html).toContain(t('pilot.verification.title'))
    expect(html).toContain(t('pilot.verification.passed'))
    expect(html).toContain(t('workspace.checksHeadVerified', { sha: 'abc1234' }))
  })

  test('a failed verification shows the failed phrase', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({ status: 'failed' }),
    })
    expect(html).toContain(t('pilot.verification.failed'))
  })

  test('a refused verification names the changed dependency files, never invents a reason', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({
        status: 'refused',
        integrity_ok: false,
        changed_dependency_files: ['package-lock.json', 'src/schema.ts'],
      }),
    })
    expect(html).toContain(t('pilot.verification.refused'))
    expect(html).toContain('package-lock.json')
    expect(html).toContain('src/schema.ts')
  })

  test('an errored verification (install/service/healthcheck failed before tests ran) shows the raw error text', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({
        status: 'error',
        error: 'install step failed: npm ci (exit 1)',
      }),
    })
    expect(html).toContain(t('pilot.verification.error'))
    expect(html).toContain('install step failed: npm ci (exit 1)')
  })

  test('the tests phase renders one real row per replayed runbook command', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({
        status: 'failed',
        checks: [
          { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 100, tail: '' },
          { command: 'bun run e2e', status: 'failed', exit_code: 1, duration_ms: 200, tail: '' },
        ],
      }),
    })
    expect(html).toContain(t('pilot.recap.tests'))
    expect(html).toContain('bun test')
    expect(html).toContain('bun run e2e')
    expect(html).toContain(t('workspace.checkPassed'))
    expect(html).toContain(t('workspace.checkFailed'))
  })

  test('an empty tests list renders no tests subsection', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      verification: verificationRecord({ status: 'error', checks: [] }),
    })
    expect(html).not.toContain(t('pilot.recap.tests'))
  })
})

describe('EvidenceBlock: the intent line declares what the agent set out to capture', () => {
  test('an intent of kind "none" alongside a "skipped" status shows the declared line and the "no proof" phrase', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        status: 'skipped',
        reason: 'the app has no UI to open',
        items: [],
        intent: { kind: 'none', reason: 'the app has no UI to open' },
      }),
    })
    expect(html).toContain(t('pilot.proof.declared'))
    expect(html).toContain(t('pilot.proof.kind.none'))
    expect(html).toContain(t('pilot.evidence.none'))
  })

  test('an intent of kind "screenshot" with pages lists the declared pages', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        intent: {
          kind: 'screenshot',
          reason: 'covers the new settings screen',
          pages: ['/settings', '/settings/billing'],
        },
      }),
    })
    expect(html).toContain(t('pilot.proof.kind.screenshot'))
    expect(html).toContain('covers the new settings screen')
    expect(html).toContain(t('pilot.proof.pages', { list: '/settings, /settings/billing' }))
  })

  test('a "skipped" status with reason "no_target" replaces the raw reason with the dedicated phrase', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        status: 'skipped',
        reason: 'no_target',
        items: [],
        intent: { kind: 'none', reason: 'no_target' },
      }),
    })
    expect(html).toContain(t('pilot.proof.noTarget'))
    expect(html).not.toContain('no_target')
  })
})

describe("EvidenceBlock: the verdict line renders the reviewer's judgment on the declared proof", () => {
  test('a coherent review shows the confirmation phrase', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        intent: { kind: 'screenshot', reason: 'covers the new screen' },
        review: { expected: 'screenshot', coherent: true, reason: 'matches the diff' },
      }),
    })
    expect(html).toContain(t('pilot.proof.coherent'))
  })

  test("an incoherent review shows the dispute phrase with the reviewer's reason", async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({
        intent: { kind: 'screenshot', reason: 'covers the new screen' },
        review: {
          expected: 'journey',
          coherent: false,
          reason: 'a flow was declared, not a static page',
        },
      }),
    })
    expect(html).toContain(
      t('pilot.proof.incoherent', { reason: 'a flow was declared, not a static page' }),
    )
  })
})

describe('EvidenceBlock: neither intent nor review present leaves the rendering unchanged', () => {
  test('no intent and no review renders neither the declared line nor the verdict line', async () => {
    const html = await render({
      projectId: 'proj-a',
      taskId: 'task-1',
      evidence: record({ items: [] }),
    })
    expect(html).not.toContain(t('pilot.proof.declared'))
    expect(html).not.toContain(t('pilot.proof.coherent'))
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
