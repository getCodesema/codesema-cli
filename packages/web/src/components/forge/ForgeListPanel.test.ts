// Same harness as ForgeBoard.test.ts. Interactivity (clicking a filter/sort/
// label chip or an item) is covered at the pure-logic level (ForgeLogic.test.ts)
// and by passing a given `selection`/prop bag directly: this file only checks
// what a given prop bag renders.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeIssuesResult, ForgeLabel, ForgeMr } from '../../types'
import type { ForgeSelection, ForgeSortKey, MrStateFilter } from './ForgeLogic'

function label(name: string): ForgeLabel {
  return { name, color: null }
}

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

function issue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1,
    title: 'first issue',
    body: '',
    state: 'open',
    labels: [],
    author: 'octocat',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/issues/1',
    ...overrides,
  }
}

function mr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 42,
    title: 'first mr',
    author: 'octocat',
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/mr/42',
    state: 'open',
    isDraft: false,
    labels: [],
    additions: null,
    deletions: null,
    changedFiles: null,
    checks: null,
    reviewers: null,
    assignees: null,
    milestone: null,
    mergeable: null,
    commits: null,
    body: null,
    ...overrides,
  }
}

function issuesState(overrides: Partial<ProjectIssuesState> = {}): ProjectIssuesState {
  return { result: null, loading: false, error: null, ...overrides }
}

function available(issues: ForgeIssue[], truncated = false): ForgeIssuesResult {
  return { available: true, truncated, issues }
}

type Props = {
  section: 'issues' | 'mrs'
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsFilter: MrStateFilter
  mrsLabels: string[]
  selection: ForgeSelection | null
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    section: 'issues',
    issuesState: issuesState(),
    issuesSort: 'updated',
    issuesLabels: [],
    mrs: [],
    mrsState: null,
    mrsSort: 'updated',
    mrsFilter: 'all',
    mrsLabels: [],
    selection: null,
    ...overrides,
  }
}

async function render(p: Partial<Props>): Promise<string> {
  const ForgeListPanel = (await import('./ForgeListPanel.vue')).default
  const app = createSSRApp(ForgeListPanel, props(p))
  return renderToString(app)
}

function mrsProps(p: Partial<Props> = {}): Partial<Props> {
  return { section: 'mrs', ...p }
}

/** The header badge's own text (the `flp-count` span's inner content), null
 * when absent. */
function countBadgeOf(html: string): string | null {
  return /<span class="flp-count">([^<]*)<\/span>/.exec(html)?.[1] ?? null
}

/** Vue SSR escapes attribute values (an aria-label carrying a literal `"`
 * around the title comes back as `&quot;`): match what the markup actually
 * contains rather than the raw i18n string. */
function htmlEscapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

describe('only the active section renders', () => {
  test('section: issues never carries the pull requests heading or content', async () => {
    const html = await render({
      section: 'issues',
      issuesState: issuesState({ result: available([issue()]) }),
      mrs: [mr({ title: 'SHOULD_NOT_APPEAR' })],
      mrsState: { status: 'loaded', truncated: false },
    })
    expect(html).not.toContain(t('forge.mrsTitle'))
    expect(html).not.toContain('SHOULD_NOT_APPEAR')
  })

  test('section: mrs never carries the issues heading or content', async () => {
    const html = await render({
      section: 'mrs',
      issuesState: issuesState({ result: available([issue({ title: 'SHOULD_NOT_APPEAR' })]) }),
      mrs: [mr()],
      mrsState: { status: 'loaded', truncated: false },
    })
    expect(html).not.toContain(t('forge.issuesTitle'))
    expect(html).not.toContain('SHOULD_NOT_APPEAR')
  })
})

describe('issues: loading / error / unavailable / empty / list', () => {
  test('no result yet: shows the loading message, no count badge', async () => {
    const html = await render({ issuesState: issuesState({ loading: true }) })
    expect(html).toContain(t('forge.loading'))
    expect(html).not.toContain('flp-count')
  })

  test('a transport error shows the error and a retry action, not a reason', async () => {
    const html = await render({ issuesState: issuesState({ error: 'HTTP 500' }) })
    expect(html).toContain(t('forge.transportError', { error: 'HTTP 500' }))
    expect(html).toContain(t('forge.retry'))
  })

  test.each([
    ['no-remote', 'forge.issuesReasonNoRemote'],
    ['no-cli', 'forge.issuesReasonNoCli'],
    ['cli-error', 'forge.issuesReasonCliError'],
    ['invalid-input', 'forge.issuesReasonInvalidInput'],
    ['unsupported', 'forge.issuesReasonUnsupported'],
  ] as const)('forge unavailable (%s) renders its own distinct message', async (reason, key) => {
    const html = await render({
      issuesState: issuesState({ result: { available: false, reason } }),
    })
    expect(html).toContain(t(key))
    expect(html).not.toContain(t('forge.issuesEmpty'))
    expect(html).not.toContain(t('forge.retry'))
  })

  test('an empty, AVAILABLE list is a success: "no open issue", never a reason', async () => {
    const html = await render({ issuesState: issuesState({ result: available([]) }) })
    expect(html).toContain(t('forge.issuesEmpty'))
    expect(countBadgeOf(html)).toBe('0')
    expect(html).not.toContain(t('forge.issuesReasonNoRemote'))
  })

  test('an unavailable result shows no count badge at all (unknown, not zero)', async () => {
    const html = await render({
      issuesState: issuesState({ result: { available: false, reason: 'no-remote' } }),
    })
    expect(html).not.toContain('flp-count')
  })

  test('a truncated list says so explicitly, with the number actually shown', async () => {
    const html = await render({
      issuesState: issuesState({
        result: available([issue({ number: 1 }), issue({ number: 2 })], true),
      }),
    })
    expect(html).toContain(t('forge.truncatedHint', { n: 2 }))
  })

  test('a non-truncated list carries no truncation caveat', async () => {
    const html = await render({ issuesState: issuesState({ result: available([issue()], false) }) })
    expect(html).not.toContain('flp-truncated')
  })

  test('default sort is most-recently-updated first', async () => {
    // Titles rendered exactly as `>title<`: a bare substring search would
    // also match the unrelated word "placeholder" in the search box markup.
    const older = issue({ number: 1, title: 'olderTitle', updatedAt: '2026-01-01T00:00:00Z' })
    const newer = issue({ number: 2, title: 'newerTitle', updatedAt: '2026-06-01T00:00:00Z' })
    const html = await render({ issuesState: issuesState({ result: available([older, newer]) }) })
    expect(html.indexOf('>newerTitle<')).toBeLessThan(html.indexOf('>olderTitle<'))
  })

  test('each issue is a selectable button carrying the select-item aria-label, not a forge link', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([issue({ title: 'fix the thing' })]) }),
    })
    expect(html).toContain(htmlEscapeAttr(t('forge.selectItemAria', { title: 'fix the thing' })))
    expect(html).toContain('class="flp-item')
    expect(html).not.toContain('target="_blank"')
  })
})

describe('pull requests: transport error / forge unavailable / empty / list / truncated', () => {
  test('a transport error shows the error, never a reason or the empty message', async () => {
    const html = await render(mrsProps({ mrsState: { status: 'error', error: 'HTTP 500' } }))
    expect(html).toContain(t('forge.transportError', { error: 'HTTP 500' }))
    expect(html).not.toContain(t('forge.mrsEmpty'))
    expect(html).not.toContain('flp-count')
  })

  test.each([
    ['no-remote', 'mrs.reasonNoRemote'],
    ['no-cli', 'mrs.reasonNoCli'],
    ['cli-error', 'mrs.reasonCliError'],
  ] as const)(
    'forge unavailable (%s) renders its own distinct message, hides the list',
    async (reason, key) => {
      const html = await render(
        mrsProps({ mrs: [mr()], mrsState: { status: 'unavailable', reason } }),
      )
      expect(html).toContain(t(key))
      expect(html).not.toContain(t('forge.mrsEmpty'))
      expect(html).not.toContain('flp-count')
    },
  )

  test('an unknown mrsState (not fetched yet) never claims unavailability, shows no count badge', async () => {
    const html = await render(mrsProps())
    expect(html).toContain(t('forge.mrsEmpty'))
    expect(html).not.toContain('flp-count')
  })

  test('an empty, LOADED list is a success: "no open merge request", with the measured 0', async () => {
    const html = await render(mrsProps({ mrsState: { status: 'loaded', truncated: false } }))
    expect(html).toContain(t('forge.mrsEmpty'))
    expect(countBadgeOf(html)).toBe('0')
  })

  test('a non-empty list renders the count and each MR', async () => {
    const html = await render(
      mrsProps({
        mrs: [mr({ number: 1 }), mr({ number: 2 })],
        mrsState: { status: 'loaded', truncated: false },
      }),
    )
    expect(countBadgeOf(html)).toBe('2')
    expect(html).toContain(t('mrs.number', { n: 1 }))
    expect(html).toContain(t('mrs.number', { n: 2 }))
  })

  test('each MR is a selectable button, not a forge link', async () => {
    const html = await render(
      mrsProps({
        mrs: [mr({ title: 'ship it' })],
        mrsState: { status: 'loaded', truncated: false },
      }),
    )
    expect(html).toContain(htmlEscapeAttr(t('forge.selectItemAria', { title: 'ship it' })))
    expect(html).not.toContain('target="_blank"')
  })

  test('a truncated MR list says so explicitly, with the number actually shown', async () => {
    const html = await render(
      mrsProps({ mrs: [mr(), mr({ number: 2 })], mrsState: { status: 'loaded', truncated: true } }),
    )
    expect(html).toContain(t('forge.truncatedHint', { n: 2 }))
  })
})

describe('count badge: plain total unfiltered, "shown / total" once a filter is active', () => {
  test('issues, no filter: the badge is the plain total, no "/" in it', async () => {
    const html = await render({
      issuesState: issuesState({
        result: available([issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })]),
      }),
    })
    expect(countBadgeOf(html)).toBe('3')
  })

  test('issues, a label active and matching some items: "shown / total"', async () => {
    const items = [
      issue({ number: 1, labels: [label('bug')] }),
      issue({ number: 2, labels: [label('ui')] }),
      issue({ number: 3, labels: [label('ui')] }),
    ]
    const html = await render({
      issuesState: issuesState({ result: available(items) }),
      issuesLabels: ['bug'],
    })
    expect(html).toContain(`>${t('forge.countFiltered', { shown: 1, total: 3 })}<`)
  })

  test('MRs, the status filter active (draft): "shown / total"', async () => {
    const items = [
      mr({ number: 1, isDraft: true }),
      mr({ number: 2, isDraft: false }),
      mr({ number: 3, isDraft: false }),
    ]
    const html = await render({
      section: 'mrs',
      mrs: items,
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'draft',
    })
    expect(html).toContain(`>${t('forge.countFiltered', { shown: 1, total: 3 })}<`)
  })

  test('MRs, the status filter AND a label both active: combined narrowing, "shown / total"', async () => {
    const items = [
      mr({ number: 1, isDraft: true, labels: [label('bug')] }),
      mr({ number: 2, isDraft: true, labels: [label('ui')] }),
      mr({ number: 3, isDraft: false, labels: [label('bug')] }),
    ]
    const html = await render({
      section: 'mrs',
      mrs: items,
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'draft',
      mrsLabels: ['bug'],
    })
    expect(html).toContain(`>${t('forge.countFiltered', { shown: 1, total: 3 })}<`)
  })
})

describe('filtered-empty state: distinct from "the forge has nothing"', () => {
  test('issues: two disjoint labels (AND semantics) leave nothing: the filtered message shows, not issuesEmpty', async () => {
    const items = [
      issue({ number: 1, labels: [label('bug')] }),
      issue({ number: 2, labels: [label('ui')] }),
    ]
    const html = await render({
      issuesState: issuesState({ result: available(items) }),
      issuesLabels: ['bug', 'ui'],
    })
    expect(html).toContain(t('forge.issuesFilteredEmpty'))
    expect(html).toContain(t('forge.clearFilters'))
    expect(html).not.toContain(t('forge.issuesEmpty'))
    expect(countBadgeOf(html)).toBe(t('forge.countFiltered', { shown: 0, total: 2 }))
  })

  test('MRs: the status filter alone leaves nothing: names the status filter specifically', async () => {
    const html = await render({
      section: 'mrs',
      mrs: [mr({ number: 1, isDraft: false })],
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'draft',
    })
    expect(html).toContain(t('forge.mrsFilteredEmptyFilter'))
    expect(html).not.toContain(t('forge.mrsFilteredEmptyLabels'))
    expect(html).not.toContain(t('forge.mrsFilteredEmptyBoth'))
    expect(html).toContain(t('forge.clearFilters'))
  })

  test('MRs: the status filter AND a label together leave nothing: names both', async () => {
    const items = [
      mr({ number: 1, isDraft: false, labels: [label('bug')] }),
      mr({ number: 2, isDraft: true, labels: [label('ui')] }),
    ]
    const html = await render({
      section: 'mrs',
      mrs: items,
      mrsState: { status: 'loaded', truncated: false },
      mrsFilter: 'draft',
      mrsLabels: ['bug'],
    })
    expect(html).toContain(t('forge.mrsFilteredEmptyBoth'))
  })
})

describe('selection: the item matching the current selection is marked current', () => {
  test('an issue selection marks its own card, not the others', async () => {
    const items = [issue({ number: 1 }), issue({ number: 2 })]
    const html = await render({
      issuesState: issuesState({ result: available(items) }),
      selection: { kind: 'issue', number: 2 },
    })
    const chunks = html.split('<button')
    const marked = chunks.filter((chunk) => chunk.includes('aria-current="true"'))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain(t('mrs.number', { n: 2 }))
    expect(html).toContain('flp-item--on')
  })

  test('no selection: no card carries aria-current', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([issue({ number: 1 })]) }),
      selection: null,
    })
    expect(html).not.toContain('aria-current')
    expect(html).not.toContain('flp-item--on')
  })

  test('an MR selection of the same number as an unrelated issue never marks the issue', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([issue({ number: 7 })]) }),
      selection: { kind: 'mr', number: 7 },
    })
    expect(html).not.toContain('aria-current')
  })

  test('a selected MR is marked current in the mrs section', async () => {
    const html = await render({
      section: 'mrs',
      mrs: [mr({ number: 5 })],
      mrsState: { status: 'loaded', truncated: false },
      selection: { kind: 'mr', number: 5 },
    })
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('flp-item--on')
  })
})

describe('matchesForgeSearch: title or number, case-insensitive, empty query matches all', () => {
  test('an empty query matches everything', async () => {
    const { matchesForgeSearch } = await import('./ForgeListPanel.vue')
    expect(matchesForgeSearch('Add forge board', 7, '')).toBe(true)
    expect(matchesForgeSearch('Add forge board', 7, '   ')).toBe(true)
  })

  test('matches a substring of the title, case-insensitively', async () => {
    const { matchesForgeSearch } = await import('./ForgeListPanel.vue')
    expect(matchesForgeSearch('Add forge board screen', 7, 'FORGE')).toBe(true)
    expect(matchesForgeSearch('Add forge board screen', 7, 'zzz')).toBe(false)
  })

  test('matches the bare number', async () => {
    const { matchesForgeSearch } = await import('./ForgeListPanel.vue')
    expect(matchesForgeSearch('Add forge board', 42, '42')).toBe(true)
    expect(matchesForgeSearch('Add forge board', 421, '42')).toBe(true)
    expect(matchesForgeSearch('Add forge board', 7, '42')).toBe(false)
  })

  test('a leading # against the number is stripped, never required', async () => {
    const { matchesForgeSearch } = await import('./ForgeListPanel.vue')
    expect(matchesForgeSearch('Add forge board', 42, '#42')).toBe(true)
    expect(matchesForgeSearch('Add forge board', 42, '42')).toBe(true)
  })

  test('neither the title nor the number matches: no match', async () => {
    const { matchesForgeSearch } = await import('./ForgeListPanel.vue')
    expect(matchesForgeSearch('Add forge board', 42, 'zzz')).toBe(false)
  })
})

describe('skeleton geometry: five cards, a diagonal stagger, no comb effect', () => {
  test('five cards, matching the geometry the panel actually renders', async () => {
    const { SKELETON_CARD_COUNT } = await import('./ForgeListPanel.vue')
    expect(SKELETON_CARD_COUNT).toBe(5)
  })

  test('the first card, first element carries no delay at all', async () => {
    const { skeletonDelay, SKELETON_ELEMENT_OFFSETS } = await import('./ForgeListPanel.vue')
    expect(skeletonDelay(0, SKELETON_ELEMENT_OFFSETS.icon)).toBe('0.00s')
  })

  test('elements within one card stagger by the documented per-element offsets', async () => {
    const { skeletonDelay, SKELETON_ELEMENT_OFFSETS } = await import('./ForgeListPanel.vue')
    expect(skeletonDelay(0, SKELETON_ELEMENT_OFFSETS.number)).toBe('0.04s')
    expect(skeletonDelay(0, SKELETON_ELEMENT_OFFSETS.author)).toBe('0.08s')
    expect(skeletonDelay(0, SKELETON_ELEMENT_OFFSETS.age)).toBe('0.12s')
    expect(skeletonDelay(0, SKELETON_ELEMENT_OFFSETS.title)).toBe('0.16s')
  })

  test('later cards stagger further, compounding with the element offset (diagonal sweep)', async () => {
    const { skeletonDelay, SKELETON_ELEMENT_OFFSETS } = await import('./ForgeListPanel.vue')
    expect(skeletonDelay(1, SKELETON_ELEMENT_OFFSETS.icon)).toBe('0.06s')
    expect(skeletonDelay(2, SKELETON_ELEMENT_OFFSETS.title)).toBe('0.28s')
    expect(skeletonDelay(4, SKELETON_ELEMENT_OFFSETS.title)).toBe('0.40s')
  })

  test('title widths cycle across consecutive cards rather than repeating one width', async () => {
    const { skeletonTitleWidth } = await import('./ForgeListPanel.vue')
    const widths = [0, 1, 2, 3, 4].map((i) => skeletonTitleWidth(i))
    expect(new Set(widths.slice(0, 3)).size).toBe(3)
    // The cycle wraps: the 4th card reuses the 1st card's width.
    expect(skeletonTitleWidth(3)).toBe(skeletonTitleWidth(0))
  })
})

describe('loading skeleton: replaces the plain loading text with card-shaped placeholders', () => {
  test('renders five skeleton cards, still carrying the loading text for assistive tech', async () => {
    const html = await render({ issuesState: issuesState({ loading: true }) })
    expect(html).toContain(t('forge.loading'))
    expect((html.match(/flp-skel-card/g) ?? []).length).toBe(5)
  })

  test('an available result never shows the skeleton', async () => {
    const html = await render({ issuesState: issuesState({ result: available([issue()]) }) })
    expect(html).not.toContain('flp-skel-card')
  })
})

describe('search box: title/number search, i18n placeholder, clear only when non-empty', () => {
  test('renders the search input with its i18n placeholder and aria-label', async () => {
    const html = await render({})
    expect(html).toContain(t('forge.listSearchPlaceholder'))
  })

  test('the clear button is absent while the search box is empty (its default state)', async () => {
    const html = await render({})
    expect(html).not.toContain(t('forge.listSearchClear'))
  })

  test('an empty search never hides an otherwise-visible list', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([issue({ title: 'fix the thing' })]) }),
    })
    expect(html).toContain('fix the thing')
    expect(html).not.toContain(t('forge.listSearchEmpty'))
  })
})

describe('footer: count (search-aware, truncation-aware) and relative freshness', () => {
  test('issues: an empty, available list reads as a plain zero count', async () => {
    const html = await render({ issuesState: issuesState({ result: available([]) }) })
    expect(html).toContain(t('forge.listFooterCountIssues', { n: 0 }, 0))
  })

  test('issues: a non-empty list is counted in the footer, distinct from the header badge', async () => {
    const items = [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })]
    const html = await render({ issuesState: issuesState({ result: available(items) }) })
    expect(html).toContain(t('forge.listFooterCountIssues', { n: 3 }, 3))
  })

  test('issues: truncated never presents the cap as a total, reuses the truncation wording', async () => {
    const html = await render({
      issuesState: issuesState({
        result: available([issue({ number: 1 }), issue({ number: 2 })], true),
      }),
    })
    expect(html).toContain(t('forge.truncatedHint', { n: 2 }))
    expect(html).not.toContain(t('forge.listFooterCountIssues', { n: 2 }, 2))
  })

  test('mrs: a loaded, non-empty list is counted with the pull-request noun', async () => {
    const html = await render(
      mrsProps({
        mrs: [mr({ number: 1 }), mr({ number: 2 })],
        mrsState: { status: 'loaded', truncated: false },
      }),
    )
    expect(html).toContain(t('forge.listFooterCountMrs', { n: 2 }, 2))
  })

  test('mrs: truncated never presents the cap as a total either', async () => {
    const html = await render(
      mrsProps({ mrs: [mr(), mr({ number: 2 })], mrsState: { status: 'loaded', truncated: true } }),
    )
    expect(html).toContain(t('forge.truncatedHint', { n: 2 }))
    expect(html).not.toContain(t('forge.listFooterCountMrs', { n: 2 }, 2))
  })

  test('a freshly rendered panel reads its freshness as just now', async () => {
    const html = await render({})
    expect(html).toContain(t('forge.listFooterFreshness', { age: t('time.justNow') }))
  })

  test('the refresh button carries its own aria-label', async () => {
    const html = await render({})
    expect(html).toContain(t('forge.listFooterRefresh'))
  })

  test('issues loading spins the refresh button; mrs never does (no loading status to read)', async () => {
    const loading = await render({ issuesState: issuesState({ loading: true }) })
    expect(loading).toContain('flp-footer-refresh--spin')

    const mrsLoaded = await render(
      mrsProps({ mrs: [mr()], mrsState: { status: 'loaded', truncated: false } }),
    )
    expect(mrsLoaded).not.toContain('flp-footer-refresh--spin')
  })
})
