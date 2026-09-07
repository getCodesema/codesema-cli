/**
 * Every glyph below exists in the shipped Cascadia Mono subset
 * (public/fonts/cascadia-mono-latin.woff2), so the browser never falls back
 * to a second font for them. A glyph is never the only carrier of meaning:
 * it always sits next to a word, a colour, or an aria-label.
 */
export const G = {
  ok: '✓',
  ko: '×',
  fail: '×',
  pending: '○',
  dot: '●',
  review: '◎',
  ask: '?',
  paused: '¦',
  shipped: '⇡',
  timeout: '◷',
  branch: '◇',
  search: '/',
  gear: '»',
  reply: '⏎',
  retry: '↑',
  expand: '▾',
  collapse: '▸',
  file: '▤',
  gap: '↕',
  arrow: '→',
  back: '←',
  sep: '·',
  minus: '−',
  attention: '!',
  shield: '◈',
  pin: '◆',
  note: '▪',
  swap: '↔',
  cursor: '▌',
  ellipsis: '…',
} as const

export type Glyph = (typeof G)[keyof typeof G]
