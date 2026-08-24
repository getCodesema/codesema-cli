// Pure color math for label pills, shared by every renderer of a ForgeLabel
// (LabelChips, ForgeIssueCard, MrMetaRail): no Vue, no DOM, testable alone.
// `ForgeLabel.color` is six lowercase hex digits with no leading `#`, or
// `null` when the forge did not say (see types.ts). `parseHexColor` is the
// one gate every entry point (contrast, pill style) goes through, so a
// string that slipped past upstream validation degrades exactly the same
// way an honest `null` does: never a crash, never an invented color.

const HEX_COLOR_PATTERN = /^[0-9a-f]{6}$/

type Rgb = { r: number; g: number; b: number }

function parseHexColor(color: string): Rgb | null {
  if (!HEX_COLOR_PATTERN.test(color)) {
    return null
  }
  return {
    r: Number.parseInt(color.slice(0, 2), 16),
    g: Number.parseInt(color.slice(2, 4), 16),
    b: Number.parseInt(color.slice(4, 6), 16),
  }
}

/** WCAG gamma-corrected linear value of one sRGB channel (0-255). */
function linearChannel(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an sRGB color, in [0, 1]. */
function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b)
}

export type LabelPillTextColor = 'black' | 'white'

/**
 * Picks whichever of pure black or pure white text has the higher WCAG
 * contrast ratio against the given background: the two are computed and
 * compared directly rather than checked against a single luminance
 * threshold, so the result is provably the better of the two at every point
 * of the scale, including both pure-white and pure-black backgrounds.
 */
function contrastTextColorForRgb(rgb: Rgb): LabelPillTextColor {
  const luminance = relativeLuminance(rgb)
  const contrastWithBlack = (luminance + 0.05) / 0.05
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  return contrastWithBlack >= contrastWithWhite ? 'black' : 'white'
}

/**
 * `contrastTextColorForRgb`, for a raw hex string. An unreadable string
 * (should not happen, see the module doc, but a renderer must not trust
 * that blindly) falls back to `'black'`, the same default a fully unsaturated
 * background would pick.
 */
export function contrastTextColor(color: string): LabelPillTextColor {
  const rgb = parseHexColor(color)
  return rgb === null ? 'black' : contrastTextColorForRgb(rgb)
}

/**
 * The CSS custom properties one label pill needs, for both of its states
 * (LabelChips) or just the rest one (the non-interactive compact pill,
 * which never enters a "selected" state). A `null` or unreadable color
 * collapses onto the same neutral fallback, itself expressed as `var(...)`
 * onto our own `--cs-*` tokens: never an invented color, never a literal hex
 * in a stylesheet.
 */
export function labelPillStyle(color: string | null): Record<string, string> {
  const rgb = color === null ? null : parseHexColor(color)
  if (rgb === null) {
    return {
      '--lp-rest-bg': 'var(--cs-line-2)',
      '--lp-selected-bg': 'var(--cs-green)',
      '--lp-selected-text': 'var(--cs-on-green)',
    }
  }
  return {
    '--lp-rest-bg': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`,
    '--lp-selected-bg': `#${color}`,
    '--lp-selected-text': contrastTextColorForRgb(rgb) === 'black' ? '#000000' : '#ffffff',
  }
}
