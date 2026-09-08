import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import {
  applyTheme,
  CONTRAST_STORAGE_KEY,
  DEFAULT_PALETTE,
  normalizeContrast,
  normalizePalette,
  PALETTE_STORAGE_KEY,
  PALETTES,
  type ThemeRoot,
} from './theme'

const tokensCss = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf-8')
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf-8')

describe('normalizePalette', () => {
  test('keeps a known id', () => {
    expect(normalizePalette('nord')).toBe('nord')
  })

  test('falls back to the default for unknown, null, empty or wrongly cased values', () => {
    expect(normalizePalette('solarized')).toBe(DEFAULT_PALETTE)
    expect(normalizePalette(null)).toBe(DEFAULT_PALETTE)
    expect(normalizePalette(undefined)).toBe(DEFAULT_PALETTE)
    expect(normalizePalette('')).toBe(DEFAULT_PALETTE)
    expect(normalizePalette('Nord')).toBe(DEFAULT_PALETTE)
  })
})

describe('PALETTES', () => {
  test('has nine distinct ids', () => {
    const ids = PALETTES.map((palette) => palette.id)
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every non-default palette has a block in tokens.css', () => {
    for (const { id } of PALETTES) {
      if (id === DEFAULT_PALETTE) {
        continue
      }
      expect(tokensCss).toMatch(new RegExp(`:root\\[data-palette=['"]${id}['"]\\] \\{`))
    }
  })

  test('the default palette has no block: bare :root is its definition', () => {
    expect(tokensCss).not.toContain(`data-palette='${DEFAULT_PALETTE}'`)
  })
})

describe('normalizeContrast', () => {
  test('only "aaa" enables the high-contrast variant', () => {
    expect(normalizeContrast('aaa')).toBe('aaa')
    expect(normalizeContrast('aa')).toBe('aa')
    expect(normalizeContrast('AAA')).toBe('aa')
    expect(normalizeContrast(null)).toBe('aa')
  })
})

const root = (): ThemeRoot => ({ dataset: {} })

describe('applyTheme', () => {
  test('the default leaves the dataset empty', () => {
    const target = root()
    applyTheme(target, DEFAULT_PALETTE, 'aa')
    expect(target.dataset).toEqual({})
  })

  test('sets both attributes for nord + aaa', () => {
    const target = root()
    applyTheme(target, 'nord', 'aaa')
    expect(target.dataset).toEqual({ palette: 'nord', contrast: 'aaa' })
  })

  test('going back to the default clears both attributes', () => {
    const target = root()
    applyTheme(target, 'gruvbox', 'aaa')
    applyTheme(target, DEFAULT_PALETTE, 'aa')
    expect(target.dataset).toEqual({})
  })
})

describe('index.html bootstrap', () => {
  test('reads the same storage keys as theme.ts', () => {
    expect(indexHtml).toContain(`'${PALETTE_STORAGE_KEY}'`)
    expect(indexHtml).toContain(`'${CONTRAST_STORAGE_KEY}'`)
    expect(indexHtml).toContain(`'${DEFAULT_PALETTE}'`)
  })

  // packages/cli/src/serve.ts injects its boot script with a single
  // `.replace('</head>', …)`: a second closing tag would break the injection.
  test('closes <head> exactly once', () => {
    expect(indexHtml.match(/<\/head>/g)).toHaveLength(1)
  })
})
