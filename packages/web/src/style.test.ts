import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const css = readFileSync(fileURLToPath(new URL('./style.css', import.meta.url)), 'utf-8')

describe('style.css theme regression guard', () => {
  test('Tailwind is wired without Preflight (would reset every existing component)', () => {
    expect(css).toContain("@import 'tailwindcss/theme.css' layer(theme);")
    expect(css).toContain("@import 'tailwindcss/utilities.css' layer(utilities);")
    expect(css).not.toContain('tailwindcss/preflight.css')
    expect(css).not.toMatch(/@import\s+['"]tailwindcss['"]/)
  })

  test('every --codesema-* light token is remapped inside .ws-root onto a --cs-* variable', () => {
    const lightRoot = css.match(/:root\s*\{([^}]*)\}/)
    expect(lightRoot).not.toBeNull()
    const lightTokenNames = [...(lightRoot?.[1] ?? '').matchAll(/(--codesema-[\w-]+):/g)].map(
      (match) => match[1] ?? '',
    )
    expect(lightTokenNames.length).toBeGreaterThan(0)

    const wsRoot = css.match(/\.ws-root\s*\{([^}]*)\}/)
    expect(wsRoot).not.toBeNull()
    const remapBody = wsRoot?.[1] ?? ''

    for (const name of lightTokenNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(remapBody).toMatch(new RegExp(`${escaped}:\\s*var\\(--cs-[\\w-]+\\)`))
    }
  })

  test('keyboard focus ring and reduced-motion guard are present in the workspace', () => {
    expect(css).toContain(
      '.ws-root :is(a, button, input, select, textarea, summary, [tabindex]):focus-visible {',
    )
    expect(css).toContain('outline: 2px solid var(--cs-focus-ring);')
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {')
    expect(css).toContain('animation-duration: 0.01ms !important;')
  })

  test('no new hex color literal leaks outside the two :root token blocks', () => {
    const withoutRootBlocks = css.replace(/:root\s*\{[^}]*\}/g, '')
    const hexLiterals = withoutRootBlocks.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    // Two pre-existing literals in the warm scrollbar thumb rules, untouched legacy code.
    expect(hexLiterals).toEqual(['#dccac4', '#c9b8be'])
  })
})

describe('foundations: the body sets both the size and the leading', () => {
  const body = css.slice(css.indexOf('body {'), css.indexOf('.codesema-muted'))

  test('14px on 1.55: the size AND the leading, since the air comes from the leading', () => {
    expect(body).toContain('font-size: 14px;')
    expect(body).toContain('line-height: 1.55;')
  })

  test('the three motion curves are tokens, and entry and exit are NOT the same curve', () => {
    expect(css).toContain('--cs-ease-in: cubic-bezier(0.16, 1, 0.3, 1);')
    expect(css).toContain('--cs-ease-out: cubic-bezier(0.3, 0, 0.8, 0.15);')
    expect(css).toContain('--cs-ease-overshoot: cubic-bezier(0.34, 1.56, 0.64, 1);')
    const easeIn = /--cs-ease-in:([^;]*);/.exec(css)?.[1]?.trim()
    const easeOut = /--cs-ease-out:([^;]*);/.exec(css)?.[1]?.trim()
    expect(easeIn).not.toBe(easeOut)
  })

  test('the shallow shadow exists alongside the two deep ones', () => {
    expect(css).toContain('--cs-shadow-hairline:')
    expect(css).toContain('--cs-shadow-panel:')
    expect(css).toContain('--cs-shadow-card:')
  })

  // Our reduced-motion guard clamps duration and iteration count. That is
  // only safe because NO animation in this package uses animation-fill-mode:
  // without it an element returns to its declared CSS (its full state) once
  // the clamped animation ends. Add a `forwards`/`both` anywhere and a
  // breathing dot would freeze on whichever keyframe happens to be last,
  // dimmer and smaller than at rest, which is the opposite of the intent.
  test('the guard clamps duration AND iteration count, never just the duration', () => {
    const guard = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(guard).toContain('animation-duration: 0.01ms !important;')
    expect(guard).toContain('animation-iteration-count: 1 !important;')
    expect(guard).toContain('transition-duration: 0.01ms !important;')
  })
})

// The invariant behind the reduced-motion guard, enforced mechanically
// across every component rather than trusted.
//
// Clamping an animation to 0.01ms with one iteration is only equivalent to
// STOPPING it because nothing here uses animation-fill-mode: with no fill
// mode an element returns to its declared CSS the instant the animation
// ends, which is its full, at-rest appearance. Add `forwards` or `both` and
// the element instead freezes on the last keyframe: a breathing dot whose
// keyframes end dim and scaled down would sit permanently dim and scaled
// down for exactly the users who asked for less motion.
//
// If this test fails, the fix is not to delete it. Either drop the fill
// mode, or extend the guard with an explicit `animation: none` for the
// element that needs one.
describe('no animation-fill-mode anywhere: the reduced-motion guard depends on it', () => {
  test('no component declares a fill mode that would freeze it on its last keyframe', () => {
    const pattern = /animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/
    // The pattern actually catches both spellings: without this a typo in
    // the regex would turn the whole test into a green light.
    expect(pattern.test('animation-fill-mode: both;')).toBe(true)
    expect(pattern.test('animation: fade 1s ease forwards;')).toBe(true)
    expect(pattern.test('animation: wq-pulse 1.6s ease-in-out infinite;')).toBe(false)

    const files = [...new Bun.Glob('**/*.{vue,css}').scanSync({ cwd: import.meta.dir })]
    // A glob that matches nothing would pass this test vacuously forever.
    expect(files.length).toBeGreaterThan(30)

    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')
      if (pattern.test(source)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
