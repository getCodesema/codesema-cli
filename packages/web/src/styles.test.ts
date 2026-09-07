import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { G } from './glyphs'

// The kit is one system: 13 colour tokens, one font, no radius, no shadow,
// three sizes. These guards keep every SFC and stylesheet inside it.

const SRC = import.meta.dir
const sources = [...new Bun.Glob('**/*.{vue,css}').scanSync({ cwd: SRC })]
  .filter((file) => !file.endsWith('.test.ts'))
  .toSorted()
const read = (file: string) => readFileSync(join(SRC, file), 'utf-8')
const styleOf = (file: string) => {
  const source = read(file)
  return file.endsWith('.vue') ? source.slice(source.indexOf('<style')) : source
}
const offenders = (predicate: (file: string) => boolean) => sources.filter(predicate)

test('the glob sees the whole package', () => {
  expect(sources.length).toBeGreaterThan(60)
  expect(sources).toContain('styles/tokens.css')
})

describe('tokens', () => {
  test('no legacy token family survives', () => {
    expect(
      offenders((file) =>
        /--cs-|--codesema-|--font-(sans|mono|display)|--fs-[a-z]/.test(read(file)),
      ),
    ).toEqual([])
  })

  test('hex colours live in tokens.css only', () => {
    expect(
      offenders(
        (file) => file !== 'styles/tokens.css' && /#[0-9a-fA-F]{3,8}\b/.test(styleOf(file)),
      ),
    ).toEqual([])
  })

  test('no rgba() or hsl() colour: a wash is a color-mix of a token', () => {
    expect(offenders((file) => /rgba?\(|hsla?\(/.test(styleOf(file)))).toEqual([])
  })
})

describe('shape', () => {
  test('no rounded corner, no shadow', () => {
    expect(
      offenders((file) => /border-radius:\s*(?!\s*0;)|box-shadow:/.test(styleOf(file))),
    ).toEqual([])
  })

  test('font sizes stay on the kit scale: var(--fs), 12px, 18px or 24px', () => {
    expect(
      offenders((file) =>
        (styleOf(file).match(/font-size:\s*[^;]+;/g) ?? []).some(
          (declaration) =>
            !/font-size:\s*(var\(--fs\)|12px|18px|24px|inherit)\s*;/.test(declaration),
        ),
      ),
    ).toEqual([])
  })

  test('only two weights: 400 and 700', () => {
    expect(
      offenders((file) =>
        (styleOf(file).match(/font-weight:\s*[^;]+;/g) ?? []).some(
          (declaration) => !/font-weight:\s*(400|700|200 700|inherit)\s*;/.test(declaration),
        ),
      ),
    ).toEqual([])
  })
})

describe('motion', () => {
  test('the only keyframes are blink (base) and slide (kit)', () => {
    const names = sources.flatMap((file) =>
      [...read(file).matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => `${file}:${match[1]}`),
    )
    expect(names).toEqual(['styles/base.css:blink', 'styles/kit.css:slide'])
  })

  // base.css clamps every animation to one 0.01ms iteration; that only stops
  // an animation because nothing keeps a fill mode.
  test('no animation-fill-mode anywhere', () => {
    const pattern = /animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/
    expect(offenders((file) => pattern.test(read(file)))).toEqual([])
  })
})

describe('glyphs', () => {
  const shipped = new Set<string>(Object.values(G))
  // Glyphs the subset font cannot draw: the browser would fall back to a
  // second font and break the monospace grid.
  const banned = new Set([
    '✕',
    '✗',
    '‖',
    '↗',
    '⎇',
    '⌕',
    '⌘',
    '⚙',
    '↩',
    '↻',
    '⚠',
    '⇄',
    '✦',
    '⏱',
    '⟲',
    '⤢',
    '⤡',
  ])

  const bannedPattern = new RegExp(`[${[...banned].join('')}]`)

  test('the banned glyphs never reach a template', () => {
    expect(
      sources
        .filter((file) => file.endsWith('.vue'))
        .filter((file) => {
          const source = read(file)
          const template = source.slice(source.indexOf('<template'), source.indexOf('</template>'))
          return bannedPattern.test(template)
        }),
    ).toEqual([])
  })

  test('the glyph set itself contains no banned glyph', () => {
    for (const glyph of banned) {
      expect(shipped.has(glyph)).toBe(false)
    }
  })
})
