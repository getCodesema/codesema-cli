import { describe, expect, test } from 'bun:test'
import type { ReviewRecord } from '../types'
import type { Finding } from './useDiff'
import { buildFixPrompt, isActionable } from './useFixPrompt'

function finding(over: Partial<Finding> = {}): Finding {
  return { file: 'src/a.ts', severity: 'major', message: 'do the thing', ...over }
}

function record(findings: Finding[], meta: Partial<ReviewRecord['meta']> = {}): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'A change',
      branch: 'feature/x',
      target: 'main',
      merge_base: 'abc123',
      repo_root: '/repo',
      created_at: '2026-08-20T00:00:00Z',
      ...meta,
    },
    commits: [],
    diff: '',
    review: {
      verdict: 'request_changes',
      summary: 'summary',
      findings,
      narrative: null,
    },
  }
}

type ParsedPrompt = {
  instruction: string
  branch: string
  target: string
  findings: Array<Record<string, unknown>>
}

function parsePrompt(prompt: string): ParsedPrompt {
  return JSON.parse(prompt) as ParsedPrompt
}

describe('isActionable', () => {
  test('a concrete finding with a non-info severity is actionable', () => {
    expect(isActionable(finding({ severity: 'critical', kind: 'security' }))).toBe(true)
    expect(isActionable(finding({ severity: 'major', kind: 'design' }))).toBe(true)
    expect(isActionable(finding({ severity: 'minor', kind: 'convention' }))).toBe(true)
    // kind is optional: absent means the finding is still actionable.
    expect(isActionable(finding({ severity: 'minor' }))).toBe(true)
  })

  test('praise and why are never actionable, whatever their severity', () => {
    expect(isActionable(finding({ kind: 'praise', severity: 'critical' }))).toBe(false)
    expect(isActionable(finding({ kind: 'why', severity: 'major' }))).toBe(false)
  })

  test('an info-severity finding is not actionable even for an actionable kind', () => {
    expect(isActionable(finding({ severity: 'info', kind: 'security' }))).toBe(false)
  })
})

describe('buildFixPrompt', () => {
  test('only the findings that isActionable accepts reach the prompt', () => {
    const findings = [
      finding({ message: 'keep the token secret', severity: 'critical', kind: 'security' }),
      finding({ message: 'nice refactor', severity: 'major', kind: 'praise' }),
      finding({ message: 'here is why', severity: 'major', kind: 'why' }),
      finding({ message: 'just an FYI', severity: 'info', kind: 'design' }),
      finding({ message: 'rename the variable', severity: 'minor', kind: 'convention' }),
    ]

    const parsed = parsePrompt(buildFixPrompt(record(findings)))

    expect(parsed.findings.map((f) => f.message)).toEqual([
      'keep the token secret',
      'rename the variable',
    ])
    // The prompt membership must track isActionable exactly, finding by finding.
    const present = new Set(parsed.findings.map((f) => f.message))
    for (const f of findings) {
      expect(present.has(f.message)).toBe(isActionable(f))
    }
  })

  test('a kept finding preserves the fields that identify it', () => {
    const f = finding({
      message: 'guard against null',
      title: 'Null guard',
      severity: 'major',
      kind: 'design',
      line: 12,
      endLine: 14,
      suggestion: 'add an early return',
    })

    const parsed = parsePrompt(buildFixPrompt(record([f])))

    expect(parsed.findings[0]!).toEqual({
      file: 'src/a.ts',
      line: 12,
      endLine: 14,
      severity: 'major',
      kind: 'design',
      title: 'Null guard',
      message: 'guard against null',
      suggestion: 'add an early return',
    })
  })

  test('the prompt carries the fix instruction and the MR !5 verification demand', () => {
    const parsed = parsePrompt(
      buildFixPrompt(record([finding()], { branch: 'wip/y', target: 'dev' })),
    )

    expect(parsed.instruction).toContain('Fix the following code review findings')
    // The scoping/verification demand added by MR !5: change ONLY what a finding requires.
    expect(parsed.instruction).toContain('Change only what each finding requires')
    expect(parsed.branch).toBe('wip/y')
    expect(parsed.target).toBe('dev')
  })

  test('with no actionable findings the prompt still renders with an empty findings list', () => {
    const parsed = parsePrompt(
      buildFixPrompt(
        record([finding({ kind: 'praise', severity: 'major' }), finding({ severity: 'info' })]),
      ),
    )

    expect(parsed.findings).toEqual([])
    // The defined behaviour is a full prompt with an empty list, not an empty string.
    expect(parsed.instruction).toContain('Fix the following code review findings')
  })

  test('an empty findings input yields an empty findings list', () => {
    expect(parsePrompt(buildFixPrompt(record([]))).findings).toEqual([])
  })

  test('onlyIds keeps just the selected findings, and only when they are actionable', () => {
    const findings = [
      finding({ message: 'a', severity: 'major' }),
      finding({ message: 'b', kind: 'praise', severity: 'major' }),
      finding({ message: 'c', severity: 'minor' }),
    ]

    // Select ids 0 and 1: id 1 is praise (not actionable) so it drops out; id 2 is not selected.
    const selected = parsePrompt(buildFixPrompt(record(findings), [0, 1]))
    expect(selected.findings.map((f) => f.message)).toEqual(['a'])

    // Without onlyIds every actionable finding is kept, in source order.
    const all = parsePrompt(buildFixPrompt(record(findings)))
    expect(all.findings.map((f) => f.message)).toEqual(['a', 'c'])
  })
})
