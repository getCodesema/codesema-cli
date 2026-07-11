import { describe, expect, test } from 'bun:test'
import type { Finding } from './contract.js'
import { formatFindingCounts } from './summary.js'

process.env.NO_COLOR = '1'

const make = (severity: Finding['severity'], kind?: Finding['kind']): Finding => ({
  file: 'src/a.ts',
  message: 'msg',
  severity,
  ...(kind ? { kind } : {}),
})

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
