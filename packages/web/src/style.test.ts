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
    // kind-convention/design/why have no dark counterpart in --cs-* yet: a
    // pre-existing gap (DiffView.vue keeps showing light-theme colors for
    // these three inside the workspace), tracked separately and out of
    // scope for the Tailwind wiring this test otherwise guards.
    const knownUnmappedTokens = new Set([
      '--codesema-kind-convention',
      '--codesema-kind-convention-soft',
      '--codesema-kind-design',
      '--codesema-kind-design-soft',
      '--codesema-kind-why',
      '--codesema-kind-why-soft',
    ])

    const lightRoot = css.match(/:root\s*\{([^}]*)\}/)
    expect(lightRoot).not.toBeNull()
    const lightTokenNames = [...(lightRoot?.[1] ?? '').matchAll(/(--codesema-[\w-]+):/g)]
      .map((match) => match[1] ?? '')
      .filter((name) => !knownUnmappedTokens.has(name))
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
