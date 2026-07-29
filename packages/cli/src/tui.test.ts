import { describe, expect, test } from 'bun:test'
import { parseYesNo } from './tui.js'

describe('parseYesNo', () => {
  test('accepts english yes/no in any case, trimmed', () => {
    expect(parseYesNo('yes')).toBe(true)
    expect(parseYesNo('y')).toBe(true)
    expect(parseYesNo(' YES ')).toBe(true)
    expect(parseYesNo('no')).toBe(false)
    expect(parseYesNo('n')).toBe(false)
    expect(parseYesNo(' No ')).toBe(false)
  })

  test('accepts french oui/non', () => {
    expect(parseYesNo('oui')).toBe(true)
    expect(parseYesNo('o')).toBe(true)
    expect(parseYesNo('non')).toBe(false)
    expect(parseYesNo('NON')).toBe(false)
  })

  test('anything else is unanswered', () => {
    expect(parseYesNo('')).toBe(null)
    expect(parseYesNo('maybe')).toBe(null)
    expect(parseYesNo('yess')).toBe(null)
    expect(parseYesNo('0')).toBe(null)
  })
})
