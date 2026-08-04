import { describe, expect, test } from 'bun:test'
import type { PartialReview } from './partial.js'
import { progressLabel, renderFieldRows } from './ui.js'

process.env.NO_COLOR = '1'

const finding = { file: 'src/a.ts', message: 'broken' }
const empty: PartialReview = { findings: [], stepTitles: [] }

describe('progressLabel', () => {
  test('null while nothing is parsed yet', () => {
    expect(progressLabel(empty)).toBeNull()
  })

  test('verdict alone', () => {
    expect(progressLabel({ ...empty, verdict: 'approve' })).toBe(
      'verdict approve · drafting findings',
    )
  })

  test('findings win over verdict', () => {
    expect(progressLabel({ ...empty, verdict: 'comment', findings: [finding, finding] })).toBe(
      '2 findings drafted',
    )
  })

  test('singular finding', () => {
    expect(progressLabel({ ...empty, findings: [finding] })).toBe('1 finding drafted')
  })

  test('steps win over findings', () => {
    const partial: PartialReview = {
      ...empty,
      findings: [finding],
      stepTitles: ['Foundations', 'Surface changes'],
    }
    expect(progressLabel(partial)).toBe('step 2: Surface changes')
  })

  test('long step title is truncated', () => {
    const partial: PartialReview = { ...empty, stepTitles: ['x'.repeat(200)] }
    const label = progressLabel(partial)
    expect(label).not.toBeNull()
    expect(label!.length).toBeLessThanOrEqual(56)
    expect(label!.endsWith('…')).toBe(true)
  })
})

describe('renderFieldRows', () => {
  test('aligns every value to the longest label in the block, padEnd(maxLen + 3)', () => {
    const lines = renderFieldRows([
      { label: 'branch', value: 'main' },
      { label: 'changes', value: '3 files' },
    ])
    expect(lines).toEqual([`  ${'branch'.padEnd(10)}main`, `  ${'changes'.padEnd(10)}3 files`])
  })

  test('a mono-line block pads to its own label length', () => {
    const lines = renderFieldRows([{ label: 'web', value: 'http://localhost:4400' }])
    expect(lines).toEqual([`  ${'web'.padEnd(6)}http://localhost:4400`])
  })

  test('preserves values verbatim, including embedded ANSI codes', () => {
    const lines = renderFieldRows([
      { label: 'a', value: '\x1b[32mgreen\x1b[0m' },
      { label: 'bb', value: 'plain value' },
    ])
    expect(lines[0]!.endsWith('\x1b[32mgreen\x1b[0m')).toBe(true)
    expect(lines[1]!.endsWith('plain value')).toBe(true)
  })

  test('empty block returns no lines', () => {
    expect(renderFieldRows([])).toEqual([])
  })

  test('alignment is computed on raw text and holds even when ANSI color codes are active', () => {
    const originalIsTTY = process.stdout.isTTY
    const originalNoColor = process.env.NO_COLOR
    process.stdout.isTTY = true
    delete process.env.NO_COLOR
    try {
      const lines = renderFieldRows([
        { label: 'branch', value: 'main' },
        { label: 'changes', value: '3 files' },
      ])
      // oxlint-disable-next-line no-control-regex -- strips ANSI color escapes
      const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
      expect(stripAnsi(lines[0]!)).toBe(`  ${'branch'.padEnd(10)}main`)
      expect(stripAnsi(lines[1]!)).toBe(`  ${'changes'.padEnd(10)}3 files`)
    } finally {
      process.stdout.isTTY = originalIsTTY
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR
      } else {
        process.env.NO_COLOR = originalNoColor
      }
    }
  })
})
