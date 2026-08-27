import { describe, expect, test } from 'bun:test'
import { maskCharacters, parseYesNo, textInput } from './tui.js'

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

describe('maskCharacters', () => {
  test('renders one * per character, never the value itself', () => {
    expect(maskCharacters('')).toBe('')
    expect(maskCharacters('a')).toBe('*')
    expect(maskCharacters('ghp_super_secret_token')).toBe(
      '*'.repeat('ghp_super_secret_token'.length),
    )
  })

  test('counts by character length, unrelated to the actual bytes typed', () => {
    expect(maskCharacters('12345')).toBe('*****')
    expect(maskCharacters('     ')).toBe('*****')
  })
})

describe('textInput mask option', () => {
  test('outside a TTY, resolves to null the same way whether masked or not', async () => {
    expect(await textInput({ title: 'token' })).toBeNull()
    expect(await textInput({ title: 'token', mask: true })).toBeNull()
  })
})
