import { describe, expect, test } from 'bun:test'
import type { Finding } from '../src/contract.js'
import { scoreFindings, type ExpectedBug } from './score.js'

const bug: ExpectedBug = { id: 'zero-div', file: 'src/stats.js', pattern: 'empty|zero|NaN' }

describe('scoreFindings', () => {
  test('a finding on the right file matching the pattern counts as found', () => {
    const findings: Finding[] = [
      { file: 'src/stats.js', severity: 'major', message: 'average of an empty array returns NaN' },
    ]
    const score = scoreFindings([bug], findings)
    expect(score.found.map((b) => b.id)).toEqual(['zero-div'])
    expect(score.missed).toEqual([])
    expect(score.extras).toBe(0)
  })

  test('wrong file or non-matching message counts as missed, unmatched findings as extras', () => {
    const findings: Finding[] = [
      { file: 'src/other.js', severity: 'major', message: 'average of an empty array returns NaN' },
      { file: 'src/stats.js', severity: 'minor', message: 'style nit' },
    ]
    const score = scoreFindings([bug], findings)
    expect(score.found).toEqual([])
    expect(score.missed.map((b) => b.id)).toEqual(['zero-div'])
    expect(score.extras).toBe(2)
  })

  test('one finding cannot satisfy two expected bugs', () => {
    const twin: ExpectedBug = { ...bug, id: 'zero-div-2' }
    const findings: Finding[] = [
      { file: 'src/stats.js', severity: 'major', message: 'divide by zero' },
    ]
    const score = scoreFindings([bug, twin], findings)
    expect(score.found).toHaveLength(1)
    expect(score.missed).toHaveLength(1)
  })

  test('pattern also matches the finding title', () => {
    const findings: Finding[] = [
      { file: 'src/stats.js', severity: 'major', title: 'NaN on empty input', message: 'm' },
    ]
    expect(scoreFindings([bug], findings).found).toHaveLength(1)
  })
})
