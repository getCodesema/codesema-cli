import { describe, expect, test } from 'bun:test'
import type { Finding, ReviewNarrative, ReviewRecord } from './contract.js'
import { formatFindingCounts, printReviewSummary } from './summary.js'

process.env.NO_COLOR = '1'

const make = (severity: Finding['severity'], kind?: Finding['kind']): Finding => ({
  file: 'src/a.ts',
  message: 'msg',
  severity,
  ...(kind ? { kind } : {}),
})

function captureLog(fn: () => void): string[] {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    fn()
  } finally {
    console.log = original
  }
  return lines
}

function buildRecord(overrides: {
  findings?: Finding[]
  narrative?: ReviewNarrative | null
}): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'Add feature',
      branch: 'feat/x',
      target: 'main',
      merge_base: 'aaa',
      head_sha: 'bbb',
      repo_root: '/repo',
      created_at: '2026-07-13T00:00:00.000Z',
    },
    commits: ['bbb'],
    diff: '',
    review: {
      verdict: 'approve',
      summary: 'looks fine',
      findings: overrides.findings ?? [],
      narrative: overrides.narrative ?? null,
    },
  }
}

describe('formatFindingCounts', () => {
  test('empty findings', () => {
    expect(formatFindingCounts([])).toBe('none')
  })

  test('praise is counted apart, not as a severity', () => {
    const findings = [make('info', 'praise'), make('critical', 'security')]
    expect(formatFindingCounts(findings)).toBe('1 critical · 1 praise')
  })

  test('severity order with zero counts omitted', () => {
    const findings = [make('minor'), make('critical'), make('minor'), make('info', 'why')]
    expect(formatFindingCounts(findings)).toBe('1 critical · 2 minor · 1 info')
  })

  test('single major', () => {
    expect(formatFindingCounts([make('major')])).toBe('1 major')
  })
})

describe('printReviewSummary', () => {
  test('verdict and findings render as a single aligned field block', () => {
    const lines = captureLog(() => printReviewSummary(buildRecord({ findings: [make('major')] })))
    expect(lines).toEqual([`  ${'verdict'.padEnd(11)}approve`, `  ${'findings'.padEnd(11)}1 major`])
  })

  test('no hotspot section when narrative has no review_first items', () => {
    const lines = captureLog(() =>
      printReviewSummary(
        buildRecord({
          narrative: { intent: 'x', confidence: 'high', steps: [], review_first: [] },
        }),
      ),
    )
    expect(lines.some((l) => l.includes('check first'))).toBe(false)
  })

  test('hotspots are preceded by a blank line and a "check first" title', () => {
    const lines = captureLog(() =>
      printReviewSummary(
        buildRecord({
          narrative: {
            intent: 'x',
            confidence: 'high',
            steps: [],
            review_first: [
              { point: 'watch the auth check', risk: 'high', step_ref: null, file: null },
            ],
          },
        }),
      ),
    )
    expect(lines[2]).toBe('')
    expect(lines[3]).toContain('check first')
  })

  test('a hotspot with a file renders the file on its own indented line, not appended to the point', () => {
    const lines = captureLog(() =>
      printReviewSummary(
        buildRecord({
          narrative: {
            intent: 'x',
            confidence: 'high',
            steps: [],
            review_first: [
              { point: 'watch the auth check', risk: 'high', step_ref: null, file: 'src/auth.ts' },
            ],
          },
        }),
      ),
    )
    const pointLine = lines.findIndex((l) => l.includes('watch the auth check'))
    expect(pointLine).toBeGreaterThan(-1)
    expect(lines[pointLine]).not.toContain('src/auth.ts')
    expect(lines[pointLine + 1]).toContain('src/auth.ts')
  })

  test('a hotspot without a file has no extra line after it', () => {
    const lines = captureLog(() =>
      printReviewSummary(
        buildRecord({
          narrative: {
            intent: 'x',
            confidence: 'high',
            steps: [],
            review_first: [
              { point: 'consider the edge case', risk: 'low', step_ref: null, file: null },
              { point: 'second point', risk: 'medium', step_ref: null, file: null },
            ],
          },
        }),
      ),
    )
    const pointLine = lines.findIndex((l) => l.includes('consider the edge case'))
    expect(lines[pointLine + 1]).toContain('second point')
  })

  test('risk labels across hotspots are aligned to the longest localized risk word', () => {
    const lines = captureLog(() =>
      printReviewSummary(
        buildRecord({
          narrative: {
            intent: 'x',
            confidence: 'high',
            steps: [],
            review_first: [
              { point: 'point one', risk: 'medium', step_ref: null, file: null },
              { point: 'point two', risk: 'low', step_ref: null, file: null },
            ],
          },
        }),
      ),
    )
    const one = lines.find((l) => l.includes('point one'))!
    const two = lines.find((l) => l.includes('point two'))!
    expect(one.indexOf('point one')).toBe(two.indexOf('point two'))
  })
})
