// Harness mirrors MrCard.test.ts / TaskConversation.test.ts: Bun's built-in
// `.vue` loader drops the template, so `vue/compiler-sfc` recompiles the SFC
// with the template inlined and `vue/server-renderer` renders it to a
// string. No DOM, no timers.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RotateCcw, TriangleAlert } from '@lucide/vue'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { EVENT_CARD_DATA_TONE, EVENT_CARD_TONES, type EventCardTone } from './EventCard'

Bun.plugin({
  name: 'vue-sfc-with-template',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor } = parse(source, { filename: args.path })
      const compiled = compileScript(descriptor, { id: args.path, inlineTemplate: true })
      return { contents: compiled.content, loader: 'ts' }
    })
  },
})

type CardProps = {
  tone?: EventCardTone
  icon?: typeof TriangleAlert
  title: string
  detail?: string | null
  token?: string | null
  defaultOpen?: boolean
}

async function renderCard(props: CardProps, body?: string): Promise<string> {
  const EventCard = (await import('./EventCard.vue')).default
  const app = createSSRApp({
    render: () => h(EventCard, props, body !== undefined ? { default: () => body } : undefined),
  })
  return renderToString(app)
}

// The mechanical guard fiche 15 section 4 asks for: the source left its
// alert-triangle color class undefined, so it silently rendered as the
// container's own muted grey — the "anormal" and "routinier" cards became
// indistinguishable by color, the icon SHAPE being all that was left to tell
// them apart. A Record<EventCardTone, StatusTone> cannot have that gap (a
// missing tone is TS2741, not a silent fallback), but the exhaustiveness of
// the TYPE only proves every tone has SOME value — it does not prove the
// values are actually different from one another. These tests prove that.
describe('EVENT_CARD_DATA_TONE (fiche 15 section 4 guard)', () => {
  test('EVENT_CARD_TONES lists exactly the four tones the brief names', () => {
    const expected: EventCardTone[] = ['neutral', 'attention', 'error', 'accent']
    expect([...EVENT_CARD_TONES].toSorted()).toEqual(expected.toSorted())
  })

  test('every tone maps to a semantic tone the kit knows, never a raw color', () => {
    for (const tone of EVENT_CARD_TONES) {
      expect(EVENT_CARD_DATA_TONE[tone]).toMatch(/^(ok|warn|err|info|idle)$/)
    }
  })

  test('the four tones resolve to four DISTINCT semantic tones', () => {
    const values = EVENT_CARD_TONES.map((tone) => EVENT_CARD_DATA_TONE[tone])
    expect(new Set(values).size).toBe(EVENT_CARD_TONES.length)
  })

  // The exact defect: 'attention' silently equal to 'neutral' would leave
  // an anomaly-flagging card the same color as a routine one.
  test("'attention' is not 'neutral' in disguise", () => {
    expect(EVENT_CARD_DATA_TONE.attention).not.toBe(EVENT_CARD_DATA_TONE.neutral)
  })
})

describe('EventCard renders the header row', () => {
  test('the title always renders, verbatim, never clipped by the renderer itself', async () => {
    const long =
      'A title long enough that a naive implementation might be tempted to truncate it anyway'
    const html = await renderCard({ title: long })
    expect(html).toContain(long)
  })

  test('no detail: the detail span is absent', async () => {
    const html = await renderCard({ title: 'Recovery' })
    expect(html).not.toContain('ec-detail')
  })

  test('a detail renders inside the truncating span', async () => {
    const html = await renderCard({ title: 'Recovery', detail: 'the previous turn was refused' })
    expect(html).toContain('the previous turn was refused')
    expect(html).toContain('ec-detail')
  })

  test('no token: the token chip is absent', async () => {
    const html = await renderCard({ title: 'Recovery' })
    expect(html).not.toContain('ec-token')
  })

  test('a token renders, right-pinned, in its own monospace chip', async () => {
    const html = await renderCard({ title: 'Recovery', token: 'a1b2c3' })
    expect(html).toContain('ec-token')
    expect(html).toContain('a1b2c3')
  })

  test('no icon prop: no icon renders', async () => {
    const html = await renderCard({ title: 'Recovery' })
    expect(html).not.toContain('ec-icon')
  })

  test('an icon prop renders the given glyph, by its stable lucide class', async () => {
    const html = await renderCard({ title: 'Recovery', icon: TriangleAlert })
    expect(html).toContain('lucide-triangle-alert')
  })
})

describe('EventCard tone reaches the rendered DOM (not just the map)', () => {
  const source = readFileSync(fileURLToPath(new URL('./EventCard.vue', import.meta.url)), 'utf-8')
  const style = source.slice(source.indexOf('<style'))

  for (const tone of EVENT_CARD_TONES) {
    test(`tone="${tone}": the card root carries its own data-tone, and no inline color`, async () => {
      const html = await renderCard({ title: 'Recovery', tone, icon: TriangleAlert })
      expect(html).toContain(`data-tone="${EVENT_CARD_DATA_TONE[tone]}"`)
      expect(html).not.toContain('style=')
    })
  }

  test('tone omitted defaults to neutral', async () => {
    const html = await renderCard({ title: 'Recovery', icon: TriangleAlert })
    expect(html).toContain(`data-tone="${EVENT_CARD_DATA_TONE.neutral}"`)
  })

  // The colors themselves now come from kit.css's `[data-tone]` -> `--tone`,
  // so what this component still owns is READING that variable: a border and
  // an icon painted with `var(--tone)`, and never a hex literal of its own.
  test('the rail and the icon are painted from var(--tone), not from a local palette', () => {
    expect(style).toContain('border-left: 2px solid var(--tone);')
    expect(style).toContain('color: var(--tone);')
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  test('the card is a rail, not a box: no frame and no surface wash of its own', () => {
    expect(style).not.toContain('border: 1px solid')
    expect(style).not.toContain('var(--bg-raised)')
  })

  test('the neutral card falls back to the plain line color, not to a state color', () => {
    expect(style).toContain("[data-tone='idle']")
  })
})

describe('EventCard fold state (fiche 15 section 6: the outcome decides the initial fold)', () => {
  test('no body slot: a static row, no button, no chevron', async () => {
    const html = await renderCard({ title: 'Cost' })
    expect(html).not.toContain('<button')
    expect(html).not.toContain('lucide-chevron-right')
    expect(html).toContain('ec-head--static')
  })

  test('a body slot with defaultOpen omitted starts folded: the body is not in the initial HTML', async () => {
    const html = await renderCard({ title: 'Recovery' }, 'the full monospace body')
    expect(html).not.toContain('the full monospace body')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('ec-chevron--open')
  })

  // The rule this reproduces: a card ANNOUNCING A FAILURE opens itself. The
  // caller passes defaultOpen based on its own outcome; this proves the seed
  // actually reaches the first render, with no client-side hydration step
  // required for the reader to see it.
  test('defaultOpen=true starts open: the body is already in the initial HTML', async () => {
    const html = await renderCard({ title: 'Sub-agents ended', defaultOpen: true }, 'a failure')
    expect(html).toContain('a failure')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('ec-chevron--open')
  })

  test('defaultOpen=false behaves exactly like omitting it', async () => {
    const html = await renderCard({ title: 'Recovery', defaultOpen: false }, 'body text')
    expect(html).not.toContain('body text')
    expect(html).toContain('aria-expanded="false"')
  })
})

// RotateCcw stands in for the "routine" icon the fiche describes (fiche 15
// section 3): EventCard does not choose it, a caller would — this only
// proves the template is not hard-coded to a single icon.
test('a different icon prop renders that icon instead, not a fixed default', async () => {
  const html = await renderCard({ title: 'Reconnecting', icon: RotateCcw })
  expect(html).toContain('lucide-rotate-ccw')
  expect(html).not.toContain('lucide-triangle-alert')
})
