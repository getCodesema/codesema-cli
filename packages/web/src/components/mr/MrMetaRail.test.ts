// SSR-string harness for every prop-driven state (same pattern as
// ForgeBoard.test.ts). One block at the bottom mounts on a null Vue renderer,
// same escape hatch as ForgeControlsPanel.test.ts / TaskComposer.test.ts: the
// passed-checks disclosure is internal ref state with no prop seeding it, and
// clicking it is exactly the interaction SSR "runs setup and stops" before
// ever reaching.
import { describe, expect, test } from 'bun:test'
import { createRenderer, createSSRApp, nextTick } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'

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

function baseMr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 42,
    title: 'Add forge board',
    author: 'octocat',
    sourceBranch: 'feat/forge-board',
    targetBranch: 'main',
    updatedAt: '2026-08-20T10:00:00.000Z',
    url: 'https://example.test/mr/42',
    state: 'open',
    isDraft: false,
    labels: [{ name: 'ui', color: null }],
    additions: 120,
    deletions: 40,
    changedFiles: 6,
    checks: { passed: 12, failed: 1, pending: 2, skipped: 0, truncated: false },
    reviewers: ['reviewer-a'],
    assignees: ['assignee-a'],
    milestone: 'v1',
    mergeable: 'mergeable',
    commits: 4,
    body: 'A body',
    ...overrides,
  }
}

async function renderRail(mr: ForgeMr): Promise<string> {
  const MrMetaRail = (await import('./MrMetaRail.vue')).default
  const app = createSSRApp(MrMetaRail, { mr })
  return renderToString(app)
}

describe('reviewers section', () => {
  test('null hides the whole section', async () => {
    const html = await renderRail(baseMr({ reviewers: null }))
    expect(html).not.toContain(t('mrs.rail.reviewers'))
  })

  test('an empty list shows the empty state', async () => {
    const html = await renderRail(baseMr({ reviewers: [] }))
    expect(html).toContain(t('mrs.rail.reviewersEmpty'))
  })

  test('a populated list renders every reviewer', async () => {
    const html = await renderRail(baseMr({ reviewers: ['alice', 'bob'] }))
    expect(html).toContain('alice')
    expect(html).toContain('bob')
  })
})

describe('assignees section', () => {
  test('null hides the whole section', async () => {
    const html = await renderRail(baseMr({ assignees: null }))
    expect(html).not.toContain(t('mrs.rail.assignees'))
  })

  test('an empty list shows the empty state', async () => {
    const html = await renderRail(baseMr({ assignees: [] }))
    expect(html).toContain(t('mrs.rail.assigneesEmpty'))
  })

  test('a populated list renders every assignee', async () => {
    const html = await renderRail(baseMr({ assignees: ['carol'] }))
    expect(html).toContain('carol')
  })
})

describe('labels section', () => {
  test('null hides the whole section', async () => {
    const html = await renderRail(baseMr({ labels: null }))
    expect(html).not.toContain(t('mrs.rail.labels'))
  })

  test('an empty list shows the empty state, not a blank section', async () => {
    const html = await renderRail(baseMr({ labels: [] }))
    expect(html).toContain(t('mrs.rail.labels'))
    expect(html).toContain(t('mrs.rail.labelsEmpty'))
  })

  test('a populated list renders every label', async () => {
    const html = await renderRail(
      baseMr({
        labels: [
          { name: 'ui', color: null },
          { name: 'backend', color: null },
        ],
      }),
    )
    expect(html).toContain('ui')
    expect(html).toContain('backend')
    expect(html).not.toContain(t('mrs.rail.labelsEmpty'))
  })

  test('a label color drives the pill fill, a null color falls back to the neutral token', async () => {
    const colored = await renderRail(baseMr({ labels: [{ name: 'bug', color: 'd73a4a' }] }))
    expect(colored).toContain('rgba(215, 58, 74, 0.16)')

    const neutral = await renderRail(baseMr({ labels: [{ name: 'bug', color: null }] }))
    expect(neutral).toContain('var(--cs-line-2)')
    expect(neutral).not.toContain('rgba(')
  })
})

describe('milestone section', () => {
  test('null hides the section', async () => {
    const html = await renderRail(baseMr({ milestone: null }))
    expect(html).not.toContain(t('mrs.rail.milestone'))
  })

  test('a value renders', async () => {
    const html = await renderRail(baseMr({ milestone: 'v2.0' }))
    expect(html).toContain('v2.0')
  })
})

describe('branches section: sourceBranch/targetBranch are never null, always renders', () => {
  test('renders both branch names under their own labels', async () => {
    const html = await renderRail(baseMr({ sourceBranch: 'feat/x', targetBranch: 'develop' }))
    expect(html).toContain(t('mrs.rail.branches'))
    expect(html).toContain(t('mrs.detailSource'))
    expect(html).toContain('feat/x')
    expect(html).toContain(t('mrs.detailTarget'))
    expect(html).toContain('develop')
  })
})

describe('changes section', () => {
  test('every field null and no mergeable state: the section disappears', async () => {
    const html = await renderRail(
      baseMr({
        additions: null,
        deletions: null,
        changedFiles: null,
        commits: null,
        mergeable: null,
      }),
    )
    expect(html).not.toContain(t('mrs.rail.changes'))
  })

  test('a single known field is enough to show the section, others fall back to a muted dash', async () => {
    const html = await renderRail(
      baseMr({
        additions: null,
        deletions: null,
        changedFiles: 6,
        commits: null,
        mergeable: null,
      }),
    )
    expect(html).toContain(t('mrs.rail.changes'))
    expect(html).toContain('<dd>6</dd>')
    // The unknown metrics render an en dash, never a bare "0".
    expect(html).toContain('<dd class="mrr-def-add">–</dd>')
    expect(html).toContain('<dd class="mrr-def-del">–</dd>')
    expect(html).toContain('<dd>–</dd>') // commits
    expect(html).not.toContain('<dd>0</dd>')
  })

  test('additions and deletions carry their sign and color class, an unknown one is a dash too', async () => {
    const html = await renderRail(baseMr({ additions: 12, deletions: null }))
    expect(html).toContain('<dd class="mrr-def-add">+12</dd>')
    expect(html).toContain('<dd class="mrr-def-del">–</dd>')
  })

  test('mergeable known: the row renders with its own state text', async () => {
    const html = await renderRail(baseMr({ mergeable: 'conflicting' }))
    expect(html).toContain(t('mrs.rail.changesMergeable'))
    expect(html).toContain(t('mrs.rail.mergeableStateConflicting'))
  })

  test('mergeable unknown (null): the row is absent, never filled with a dash', async () => {
    const html = await renderRail(baseMr({ mergeable: null, changedFiles: 6 }))
    expect(html).toContain(t('mrs.rail.changes'))
    expect(html).not.toContain(t('mrs.rail.changesMergeable'))
  })
})

describe('dates section: updatedAt is never null, always renders as the last section', () => {
  test('renders the relative age', async () => {
    const html = await renderRail(
      baseMr({ updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
    )
    expect(html).toContain(t('mrs.rail.dates'))
    expect(html).toContain(t('mrs.rail.updatedAt', { age: t('time.hoursAgo', { n: 3 }) }))
  })

  test('is the last section: no bottom rule follows it', async () => {
    const html = await renderRail(baseMr())
    const sections = html.split('<section class="mrr-section">')
    const lastSection = sections[sections.length - 1] ?? ''
    expect(lastSection).toContain(t('mrs.rail.dates'))
  })
})

describe('auto-review: the section always renders, its four states are never confused', () => {
  test('checks null: "unavailable", never "no checks"', async () => {
    const html = await renderRail(baseMr({ checks: null }))
    expect(html).toContain(t('mrs.rail.autoReview'))
    expect(html).toContain(t('mrs.rail.autoReviewUnavailable'))
    expect(html).not.toContain(t('mrs.rail.autoReviewNone'))
  })

  test('checks present but every bucket at zero, not truncated: "no checks", never "unavailable"', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 0, failed: 0, pending: 0, skipped: 0, truncated: false } }),
    )
    expect(html).toContain(t('mrs.rail.autoReviewNone'))
    expect(html).not.toContain(t('mrs.rail.autoReviewUnavailable'))
  })

  test('checks present with real counts: failures and pending are spelled out under "needs attention"', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 42, failed: 2, pending: 1, skipped: 0, truncated: false } }),
    )
    expect(html).toContain(t('mrs.rail.autoReviewAttention'))
    expect(html).toContain(t('mrs.checks.failed', { n: 2 }, 2))
    expect(html).toContain(t('mrs.checks.pending', { n: 1 }, 1))
    expect(html).not.toContain(t('mrs.checks.skipped', { n: 0 }, 0))
  })

  test('skipped checks are spelled out too when present', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 10, failed: 0, pending: 0, skipped: 3, truncated: false } }),
    )
    expect(html).toContain(t('mrs.checks.skipped', { n: 3 }, 3))
  })

  test('no failure/pending/skipped: the "needs attention" group is absent', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 10, failed: 0, pending: 0, skipped: 0, truncated: false } }),
    )
    expect(html).not.toContain(t('mrs.rail.autoReviewAttention'))
  })

  test('passed starts folded: a bare count is shown, the full phrase only lives in the accessible name', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 42, failed: 2, pending: 0, skipped: 0, truncated: false } }),
    )
    expect(html).toContain(t('mrs.rail.autoReviewPassedGroup'))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain(`aria-label="${t('mrs.checks.passed', { n: 42 }, 42)}"`)
    // The visible, non-accessibility-tree text is the bare number.
    expect(html).toContain('aria-hidden="true">42<')
  })

  test('truncated falls back to an aggregate signal, never the detailed groups or the passed button', async () => {
    const html = await renderRail(
      baseMr({ checks: { passed: 34, failed: 1, pending: 0, skipped: 0, truncated: true } }),
    )
    expect(html).toContain(t('mrs.checks.aggregateFailed'))
    expect(html).not.toContain('mrr-check-passed')
    expect(html).not.toContain(t('mrs.rail.autoReviewAttention'))
    expect(html).not.toContain(t('mrs.checks.passed', { n: 34 }, 34))
  })
})

// ── Interactive: mounted on a null Vue renderer (same escape hatch as
// ForgeControlsPanel.test.ts / TaskComposer.test.ts). SSR "runs setup and
// stops" before a click ever reaches internal ref state. ──────────────────
type FakeNode = {
  tag: string
  text: string
  parent: FakeNode | null
  children: FakeNode[]
  attrs: Record<string, unknown>
  listeners: Record<string, (event?: unknown) => void>
  value: string
  focus: () => void
  addEventListener: () => void
  removeEventListener: () => void
}

function fakeNode(tag: string): FakeNode {
  return {
    tag,
    text: '',
    parent: null,
    children: [],
    attrs: {},
    listeners: {},
    value: '',
    focus: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

const { createApp: createNullApp } = createRenderer<FakeNode, FakeNode>({
  createElement: (tag) => fakeNode(tag),
  createText: (text) => Object.assign(fakeNode('#text'), { text }),
  createComment: (text) => Object.assign(fakeNode('#comment'), { text }),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  insert: (child, parent, anchor) => {
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at === -1) {
      parent.children.push(child)
    } else {
      parent.children.splice(at, 0, child)
    }
  },
  remove: (child) => {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  // The compiler stringifies large fully-static subtrees (every section's
  // static SVG icon path qualifies): the renderer must be able to insert an
  // opaque block for them even though this fake DOM cannot parse HTML.
  insertStaticContent: (content, parent, anchor) => {
    const node = fakeNode('#static')
    node.text = content
    node.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at === -1) {
      parent.children.push(node)
    } else {
      parent.children.splice(at, 0, node)
    }
    return [node, node]
  },
  patchProp: (el, key, _prev, next) => {
    if (key.startsWith('on') && key.length > 2) {
      const event = (key[2] as string).toLowerCase() + key.slice(3)
      el.listeners[event] = next as (event?: unknown) => void
      return
    }
    el.attrs[key] = next
  },
})

function findAll(root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (n: FakeNode): void => {
    if (pred(n)) {
      out.push(n)
    }
    for (const child of n.children) {
      walk(child)
    }
  }
  walk(root)
  return out
}

function find(root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode | null {
  return findAll(root, pred)[0] ?? null
}

function hasClass(node: FakeNode, cls: string): boolean {
  const value = node.attrs.class
  return typeof value === 'string' && value.split(/\s+/).includes(cls)
}

/** Concatenates every text-bearing node under `node`, skipping opaque static
 * content blocks (a fully static icon's raw SVG markup would otherwise leak
 * into the result: see insertStaticContent above). */
function textOf(node: FakeNode): string {
  let out = ''
  const walk = (n: FakeNode): void => {
    if (n.tag === '#static') {
      return
    }
    if (n.text) {
      out += n.text
    }
    for (const child of n.children) {
      walk(child)
    }
  }
  walk(node)
  return out
}

describe('the passed-checks disclosure (interactive)', () => {
  async function mountRail(mr: ForgeMr): Promise<FakeNode> {
    const MrMetaRail = (await import('./MrMetaRail.vue')).default
    const root = fakeNode('#root')
    const app = createNullApp(MrMetaRail, { mr })
    app.mount(root)
    await nextTick()
    return root
  }

  test('closed by default, clicking reveals the full phrase and flips aria-expanded, clicking again folds it back', async () => {
    const root = await mountRail(
      baseMr({ checks: { passed: 42, failed: 0, pending: 0, skipped: 0, truncated: false } }),
    )

    const button = find(root, (n) => hasClass(n, 'mrr-check-passed'))
    expect(button).not.toBeNull()
    expect(button?.attrs['aria-expanded']).toBe(false)
    expect(textOf(button as FakeNode)).toBe('42')

    button?.listeners.click?.()
    await nextTick()

    expect(button?.attrs['aria-expanded']).toBe(true)
    expect(textOf(button as FakeNode)).toBe(t('mrs.checks.passed', { n: 42 }, 42))

    button?.listeners.click?.()
    await nextTick()

    expect(button?.attrs['aria-expanded']).toBe(false)
    expect(textOf(button as FakeNode)).toBe('42')
  })
})
