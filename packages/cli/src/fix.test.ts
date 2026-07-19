import { describe, expect, test } from 'bun:test'
import { sanitizeRecord } from './contract.js'
import { buildAgentFixPrompt, createFixRunner, fixCommandFor } from './fix.js'

describe('fixCommandFor', () => {
  test('claude gets acceptEdits permission mode', () => {
    expect(fixCommandFor('claude -p')).toBe('claude -p --permission-mode acceptEdits')
    expect(fixCommandFor('claude -p --model opus')).toBe('claude -p --model opus --permission-mode acceptEdits')
  })

  test('codex exec gets a workspace-write sandbox, before the stdin dash', () => {
    expect(fixCommandFor('codex exec -')).toBe('codex exec --sandbox workspace-write -')
    expect(fixCommandFor('codex exec -m gpt-5.5 -')).toBe('codex exec --sandbox workspace-write -m gpt-5.5 -')
  })

  test('gemini gets auto_edit approval mode', () => {
    expect(fixCommandFor('gemini')).toBe('gemini --approval-mode auto_edit')
    expect(fixCommandFor('gemini -m gemini-2.5-pro')).toBe('gemini -m gemini-2.5-pro --approval-mode auto_edit')
  })

  test('commands already carrying an edit flag are left alone', () => {
    expect(fixCommandFor('claude -p --permission-mode plan')).toBe('claude -p --permission-mode plan')
    expect(fixCommandFor('codex exec --sandbox danger-full-access -')).toBe('codex exec --sandbox danger-full-access -')
    expect(fixCommandFor('codex exec --full-auto -')).toBe('codex exec --full-auto -')
    expect(fixCommandFor('gemini --yolo')).toBe('gemini --yolo')
    expect(fixCommandFor('gemini --approval-mode yolo')).toBe('gemini --approval-mode yolo')
  })

  test('custom commands are used verbatim', () => {
    expect(fixCommandFor('my-agent --edit')).toBe('my-agent --edit')
  })
})

function record() {
  return sanitizeRecord({
    meta: { title: 't', branch: 'feature/x', target: 'develop', head_sha: 'abc123' },
    review: {
      verdict: 'request_changes',
      summary: 's',
      findings: [
        { file: 'src/a.ts', line: 3, severity: 'major', message: 'broken null check', suggestion: 'use ??' },
        { file: 'src/b.ts', severity: 'minor', message: 'rename this' },
        { file: 'src/c.ts', severity: 'info', kind: 'praise', message: 'nice' },
      ],
    },
  })!
}

describe('buildAgentFixPrompt', () => {
  test('embeds only the selected findings', () => {
    const prompt = buildAgentFixPrompt(record(), [0])
    expect(prompt).toContain('broken null check')
    expect(prompt).toContain('use ??')
    expect(prompt).not.toContain('rename this')
    expect(prompt).toContain('feature/x')
    expect(prompt).toContain('Do NOT commit')
  })

  test('demands a red-first regression test for reproducible bugs', () => {
    const prompt = buildAgentFixPrompt(record(), [0])
    expect(prompt).toContain('write the regression test FIRST')
    expect(prompt).toContain('it must fail on the current code')
    expect(prompt).toContain('part of applying the finding, not an extra change')
    expect(prompt).toContain('tautological test')
  })

  test('demands a post-edit check run with a fallback when commands are unavailable', () => {
    const prompt = buildAgentFixPrompt(record(), [0])
    expect(prompt).toContain('cheap checks (typecheck, unit tests, lint)')
    expect(prompt).toContain('fix what YOUR change broke')
    expect(prompt).toContain('Do not chase pre-existing failures')
    expect(prompt).toContain('skip this step and say so in the summary')
    expect(prompt).toContain('how you verified')
  })
})

describe('createFixRunner', () => {
  const base = (overrides: Partial<Parameters<typeof createFixRunner>[0]> = {}) =>
    createFixRunner({
      getRecord: () => record(),
      cwd: '/tmp',
      command: 'claude -p',
      timeoutMs: 1000,
      currentHead: () => 'abc123',
      runAgentFn: async () => 'fixed everything',
      ...overrides,
    })

  test('reports idle with head_moved=false when HEAD matches', () => {
    const runner = base()
    expect(runner.status()).toMatchObject({ phase: 'idle', head_moved: false, selected: [] })
  })

  test('head_moved=true when HEAD differs from the reviewed sha', () => {
    const runner = base({ currentHead: () => 'zzz999' })
    expect(runner.status().head_moved).toBe(true)
  })

  test('runs the agent and lands on done with the summary', async () => {
    let seenPrompt = ''
    let seenCommand = ''
    const runner = base({
      runAgentFn: async (opts) => {
        seenPrompt = opts.prompt
        seenCommand = opts.command
        return 'two files patched'
      },
    })
    const started = runner.start([0, 1])
    expect(started.ok).toBe(true)
    while (runner.status().phase === 'running') await new Promise((r) => setTimeout(r, 5))
    expect(runner.status()).toMatchObject({ phase: 'done', summary: 'two files patched', selected: [0, 1] })
    expect(seenPrompt).toContain('broken null check')
    expect(seenCommand).toBe('claude -p --permission-mode acceptEdits')
  })

  test('rejects invalid or empty selections', () => {
    const runner = base()
    expect(runner.start([])).toMatchObject({ ok: false, code: 400 })
    expect(runner.start([99])).toMatchObject({ ok: false, code: 400 })
    expect(runner.start([0.5] as unknown as number[])).toMatchObject({ ok: false, code: 400 })
  })

  test('rejects praise/info findings that have nothing to fix', () => {
    const runner = base()
    expect(runner.start([2])).toMatchObject({ ok: false, code: 400 })
  })

  test('only one fix runs at a time', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const runner = base({
      runAgentFn: async () => {
        await gate
        return 'ok'
      },
    })
    expect(runner.start([0]).ok).toBe(true)
    expect(runner.start([0])).toMatchObject({ ok: false, code: 409 })
    release()
    while (runner.status().phase === 'running') await new Promise((r) => setTimeout(r, 5))
    expect(runner.start([1]).ok).toBe(true)
  })

  test('lands on error when the agent fails, and can retry', async () => {
    const runner = base({
      runAgentFn: async () => {
        throw new Error('agent exploded')
      },
    })
    expect(runner.start([0]).ok).toBe(true)
    while (runner.status().phase === 'running') await new Promise((r) => setTimeout(r, 5))
    expect(runner.status()).toMatchObject({ phase: 'error', error: 'agent exploded' })
    expect(runner.start([0]).ok).toBe(true)
  })

  test('refuses to start without a record', () => {
    const runner = base({ getRecord: () => null })
    expect(runner.start([0])).toMatchObject({ ok: false, code: 409 })
  })
})
