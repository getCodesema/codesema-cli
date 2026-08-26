import { describe, expect, test } from 'bun:test'
import type { ReviewRecord } from '../types'
import type { Finding } from './useDiff'
import { buildFixPrompt, isActionable } from './useFixPrompt'

function finding(overrides: Partial<Finding> & { file: string; message: string }): Finding {
  return { severity: 'major', ...overrides }
}

function record(findings: Finding[]): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'Fix the thing',
      branch: 'feature/x',
      target: 'main',
      merge_base: 'abc123',
      repo_root: '/repo',
      created_at: '2026-08-20T09:00:00.000Z',
    },
    commits: ['abc123'],
    diff: '',
    review: { verdict: 'request_changes', summary: 's', findings, narrative: null },
  }
}

describe('isActionable', () => {
  test('praise, why and info findings are not actionable', () => {
    expect(isActionable(finding({ file: 'a.ts', message: 'm', kind: 'praise' }))).toBe(false)
    expect(isActionable(finding({ file: 'a.ts', message: 'm', kind: 'why' }))).toBe(false)
    expect(
      isActionable(finding({ file: 'a.ts', message: 'm', severity: 'info', kind: 'design' })),
    ).toBe(false)
  })

  test('a defect finding is actionable whatever its kind', () => {
    expect(isActionable(finding({ file: 'a.ts', message: 'm', kind: 'security' }))).toBe(true)
    expect(isActionable(finding({ file: 'a.ts', message: 'm', severity: 'minor' }))).toBe(true)
  })
})

describe('buildFixPrompt', () => {
  test('keeps only actionable findings and omits absent optional fields', () => {
    const prompt = buildFixPrompt(
      record([
        finding({ file: 'skip.ts', message: 'nice', kind: 'praise' }),
        finding({
          file: 'src/a.ts',
          line: 3,
          endLine: 5,
          kind: 'security',
          title: 'T',
          message: 'M',
          suggestion: 'S',
        }),
        finding({ file: 'src/b.ts', severity: 'minor', message: 'bare' }),
      ]),
    )
    const parsed = JSON.parse(prompt) as {
      instruction: string
      branch: string
      target: string
      findings: Record<string, unknown>[]
    }
    expect(parsed.instruction).toContain('Fix the following code review findings')
    expect(parsed.branch).toBe('feature/x')
    expect(parsed.target).toBe('main')
    expect(parsed.findings).toEqual([
      {
        file: 'src/a.ts',
        line: 3,
        endLine: 5,
        severity: 'major',
        kind: 'security',
        title: 'T',
        message: 'M',
        suggestion: 'S',
      },
      { file: 'src/b.ts', severity: 'minor', message: 'bare' },
    ])
  })

  test('onlyIds filters by position in record.review.findings', () => {
    const prompt = buildFixPrompt(
      record([
        finding({ file: 'src/a.ts', message: 'first' }),
        finding({ file: 'src/b.ts', message: 'second' }),
      ]),
      [1],
    )
    const parsed = JSON.parse(prompt) as { findings: Record<string, unknown>[] }
    expect(parsed.findings).toEqual([{ file: 'src/b.ts', severity: 'major', message: 'second' }])
  })
})
