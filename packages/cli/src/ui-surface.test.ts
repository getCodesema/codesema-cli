import { describe, expect, test } from 'bun:test'
import { classifyUiPaths } from './ui-surface.js'

describe('classifyUiPaths', () => {
  test('recognizes UI extensions', () => {
    expect(classifyUiPaths(['Button.vue', 'App.tsx', 'index.html', 'main.scss']).ui).toEqual([
      'Button.vue',
      'App.tsx',
      'index.html',
      'main.scss',
    ])
  })

  test('classifies non-UI extensions as other', () => {
    expect(classifyUiPaths(['server.ts', 'README.md', 'package.json']).other).toEqual([
      'server.ts',
      'README.md',
      'package.json',
    ])
  })

  test('recognizes UI path hint segment', () => {
    expect(classifyUiPaths(['src/components/x.ts']).ui).toEqual(['src/components/x.ts'])
  })

  test('recognizes whole segment app as UI hint, not a prefix match', () => {
    expect(classifyUiPaths(['app/server.ts']).ui).toEqual(['app/server.ts'])
    expect(classifyUiPaths(['application/x.ts']).other).toEqual(['application/x.ts'])
  })

  test('recognizes styles path hint segment', () => {
    expect(classifyUiPaths(['styles/tokens.ts']).ui).toEqual(['styles/tokens.ts'])
  })

  test('extension match is case-insensitive', () => {
    expect(classifyUiPaths(['Legacy.VUE']).ui).toEqual(['Legacy.VUE'])
  })

  test('normalizes leading ./ and backslash separators before classifying', () => {
    const result = classifyUiPaths(['./src/pages/a.ts', 'src\\views\\b.ts'])
    expect(result.ui).toEqual(['./src/pages/a.ts', 'src\\views\\b.ts'])
    expect(result.other).toEqual([])
  })

  test('preserves input order and keeps duplicates', () => {
    const result = classifyUiPaths(['server.ts', 'App.tsx', 'server.ts', 'README.md', 'App.tsx'])
    expect(result.ui).toEqual(['App.tsx', 'App.tsx'])
    expect(result.other).toEqual(['server.ts', 'server.ts', 'README.md'])
  })

  test('empty input returns two empty arrays', () => {
    expect(classifyUiPaths([])).toEqual({ ui: [], other: [] })
  })

  test('ignores empty path entries', () => {
    expect(classifyUiPaths(['', 'server.ts', ''])).toEqual({ ui: [], other: ['server.ts'] })
  })
})
