import { describe, expect, test } from 'bun:test'
import { contrastTextColor, labelPillStyle } from './LabelColor'

describe('contrastTextColor', () => {
  test('pure white picks black text', () => {
    expect(contrastTextColor('ffffff')).toBe('black')
  })

  test('pure black picks white text', () => {
    expect(contrastTextColor('000000')).toBe('white')
  })

  test('a clear (light) color picks black text', () => {
    expect(contrastTextColor('fbca04')).toBe('black')
  })

  test('a dark color picks white text', () => {
    expect(contrastTextColor('0b3d91')).toBe('white')
  })

  test('an intermediate mid-gray picks black text', () => {
    expect(contrastTextColor('808080')).toBe('black')
  })

  test('a malformed color (wrong length) falls back to black rather than throwing', () => {
    expect(contrastTextColor('fff')).toBe('black')
  })

  test('a malformed color (non-hex characters) falls back to black rather than throwing', () => {
    expect(contrastTextColor('zzzzzz')).toBe('black')
  })

  test('a malformed color (leading #, which the contract forbids) falls back to black', () => {
    expect(contrastTextColor('#ffffff')).toBe('black')
  })

  test('an empty string falls back to black rather than throwing', () => {
    expect(contrastTextColor('')).toBe('black')
  })
})

describe('labelPillStyle', () => {
  test('a null color falls back to the neutral --cs-* tokens, never an invented color', () => {
    expect(labelPillStyle(null)).toEqual({
      '--lp-rest-bg': 'var(--cs-line-2)',
      '--lp-selected-bg': 'var(--cs-green)',
      '--lp-selected-text': 'var(--cs-on-green)',
    })
  })

  test('a malformed color that slipped past validation falls back to the same neutral tokens', () => {
    expect(labelPillStyle('not-a-color')).toEqual({
      '--lp-rest-bg': 'var(--cs-line-2)',
      '--lp-selected-bg': 'var(--cs-green)',
      '--lp-selected-text': 'var(--cs-on-green)',
    })
  })

  test('a valid color derives the rest fill at 16% opacity and the full selected fill', () => {
    expect(labelPillStyle('2da44e')).toEqual({
      '--lp-rest-bg': 'rgba(45, 164, 78, 0.16)',
      '--lp-selected-bg': '#2da44e',
      '--lp-selected-text': '#000000',
    })
  })

  test('a valid dark color computes a white selected text color', () => {
    const style = labelPillStyle('0b3d91')
    expect(style['--lp-selected-bg']).toBe('#0b3d91')
    expect(style['--lp-selected-text']).toBe('#ffffff')
  })
})
