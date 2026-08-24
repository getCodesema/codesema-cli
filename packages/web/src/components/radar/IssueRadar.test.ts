// Same harness as MrCard.test.ts / WorkspaceHeader.test.ts. Interactivity
// (clicking a filter/sort/label chip, toggling an accordion) is covered at
// the pure-logic level (RadarLogic.test.ts, RadarPrefs.test.ts) and by
// seeding the persisted prefs blob below: this file only checks what a given
// prop bag (and, for the fold state, a given localStorage) renders.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectIssuesState } from '../../composables/useIssues'
import { t } from '../../i18n'
import type { ForgeIssue, ForgeIssuesResult, ForgeMr, WorkspaceInfo } from '../../types'

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

function workspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    isolation_available: true,
    isolation_default: 'container',
    isolation_reason: 'ok',
    ...overrides,
  }
}

async function render(props: {
  issuesState: ProjectIssuesState
  mrs: ForgeMr[]
  workspace: WorkspaceInfo | null
}): Promise<string> {
  const IssueRadar = (await import('./IssueRadar.vue')).default
  const app = createSSRApp(IssueRadar, props)
  return renderToString(app)
}

/** The Issues accordion's own markup, cut off before the Pull requests one:
 * `ra-count`/`ra-truncated` etc. are shared class names between both
 * sections, so an assertion about ONE section must not read the other's. */
function issuesSectionOf(html: string): string {
  return html.slice(0, html.indexOf('Pull requests'))
}

describe('issues: loading / error / unavailable / empty / list', () => {
  test('no result yet: shows the loading message, no count badge', async () => {
    const html = await render({
      issuesState: issuesState({ loading: true }),
      mrs: [],
      workspace: null,
    })
    expect(html).toContain(t('radar.loading'))
    expect(issuesSectionOf(html)).not.toContain('ra-count')
  })

  test('a transport error shows the error and a retry action, not a reason', async () => {
    const html = await render({
      issuesState: issuesState({ error: 'HTTP 500' }),
      mrs: [],
      workspace: null,
    })
    expect(html).toContain(t('radar.transportError', { error: 'HTTP 500' }))
    expect(html).toContain(t('radar.retry'))
  })

  test.each([
    ['no-remote', 'radar.issuesReasonNoRemote'],
    ['no-cli', 'radar.issuesReasonNoCli'],
    ['cli-error', 'radar.issuesReasonCliError'],
    ['invalid-input', 'radar.issuesReasonInvalidInput'],
    ['unsupported', 'radar.issuesReasonUnsupported'],
  ] as const)('forge unavailable (%s) renders its own distinct message', async (reason, key) => {
    const html = await render({
      issuesState: issuesState({ result: { available: false, reason } }),
      mrs: [],
      workspace: null,
    })
    expect(html).toContain(t(key))
    // Never confused with "no open issue" (a success), nor with the retry flow.
    expect(html).not.toContain(t('radar.issuesEmpty'))
    expect(html).not.toContain(t('radar.retry'))
  })

  test('an empty, AVAILABLE list is a success: "no open issue", never a reason', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([]) }),
      mrs: [],
      workspace: null,
    })
    expect(html).toContain(t('radar.issuesEmpty'))
    expect(html).toContain('>0<') // count badge shows the measured zero
    expect(html).not.toContain(t('radar.issuesReasonNoRemote'))
  })

  test('an unavailable result shows no count badge at all (unknown, not zero)', async () => {
    const html = await render({
      issuesState: issuesState({ result: { available: false, reason: 'no-remote' } }),
      mrs: [],
      workspace: null,
    })
    expect(issuesSectionOf(html)).not.toContain('ra-count')
  })

  test('a truncated list says so explicitly, with the number actually shown', async () => {
    const html = await render({
      issuesState: issuesState({
        result: available([issue({ number: 1 }), issue({ number: 2 })], true),
      }),
      mrs: [],
      workspace: null,
    })
    expect(html).toContain(t('radar.truncatedHint', { n: 2 }))
  })

  test('a non-truncated list carries no truncation caveat', async () => {
    const html = await render({
      issuesState: issuesState({ result: available([issue()], false) }),
      mrs: [],
      workspace: null,
    })
    expect(html).not.toContain('ra-truncated')
  })

  test('default sort is most-recently-updated first', async () => {
    const older = issue({ number: 1, title: 'older', updatedAt: '2026-01-01T00:00:00Z' })
    const newer = issue({ number: 2, title: 'newer', updatedAt: '2026-06-01T00:00:00Z' })
    const html = await render({
      issuesState: issuesState({ result: available([older, newer]) }),
      mrs: [],
      workspace: null,
    })
    expect(html.indexOf('newer')).toBeLessThan(html.indexOf('older'))
  })

  test('each issue links to its forge URL and carries the open-in-forge aria-label', async () => {
    const html = await render({
      issuesState: issuesState({
        result: available([issue({ url: 'https://example.test/issues/9' })]),
      }),
      mrs: [],
      workspace: null,
    })
    expect(html).toContain('href="https://example.test/issues/9"')
    expect(html).toContain('target="_blank"')
  })

  test('label chips render from the loaded issues, hidden on an empty list', async () => {
    const withLabels = await render({
      issuesState: issuesState({ result: available([issue({ labels: ['bug'] })]) }),
      mrs: [],
      workspace: null,
    })
    expect(withLabels).toContain('bug')

    const empty = await render({
      issuesState: issuesState({ result: available([]) }),
      mrs: [],
      workspace: null,
    })
    expect(empty).not.toContain('lc-chip')
  })
})

describe('pull requests: forge unavailable vs empty vs list', () => {
  test('forge unavailable (workspace overlay) hides the list and its controls', async () => {
    const html = await render({
      issuesState: issuesState(),
      mrs: [mr()],
      workspace: workspace({ forge_available: false, forge_reason: 'no-cli' }),
    })
    expect(html).toContain(t('workspace.forgeReasonNoCli'))
    expect(html).not.toContain('ir-filters')
  })

  test('an unknown workspace (null) never claims unavailability', async () => {
    const html = await render({ issuesState: issuesState(), mrs: [], workspace: null })
    expect(html).toContain(t('radar.mrsEmpty'))
  })

  test('an empty, available MR list renders "no open merge request"', async () => {
    const html = await render({ issuesState: issuesState(), mrs: [], workspace: workspace() })
    expect(html).toContain(t('radar.mrsEmpty'))
  })

  test('a non-empty list renders the count, the status filter chips and each MR', async () => {
    const html = await render({
      issuesState: issuesState(),
      mrs: [mr({ number: 1 }), mr({ number: 2 })],
      workspace: workspace(),
    })
    expect(html).toContain('>2<')
    expect(html).toContain(t('radar.filterAll'))
    expect(html).toContain(t('radar.filterDraft'))
    expect(html).toContain(t('radar.filterReady'))
    expect(html).toContain(t('mrs.number', { n: 1 }))
    expect(html).toContain(t('mrs.number', { n: 2 }))
  })

  test('each MR links to its forge URL', async () => {
    const html = await render({
      issuesState: issuesState(),
      mrs: [mr({ url: 'https://example.test/mr/99' })],
      workspace: workspace(),
    })
    expect(html).toContain('href="https://example.test/mr/99"')
  })

  test('never claims a truncation the mrsByProject cache cannot report', async () => {
    const html = await render({
      issuesState: issuesState(),
      mrs: [mr(), mr({ number: 2 })],
      workspace: workspace(),
    })
    expect(html).not.toContain('ra-truncated')
  })
})

describe('the two accordions fold independently, from the persisted prefs blob', () => {
  test('issuesOpen: false hides the issues body while the MR accordion stays open', async () => {
    const store = new Map<string, string>()
    store.set(
      'codesema-ws-radar-prefs',
      JSON.stringify({
        issuesOpen: false,
        mrsOpen: true,
        issuesSort: 'updated',
        mrsSort: 'updated',
        mrsFilter: 'all',
        issuesLabels: [],
        mrsLabels: [],
      }),
    )
    const stub = { getItem: (key: string) => store.get(key) ?? null, setItem: () => {} }
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      globals.localStorage = stub
      const html = await render({
        issuesState: issuesState({ result: available([issue({ title: 'HIDDEN_ISSUE' })]) }),
        mrs: [mr({ title: 'SHOWN_MR' })],
        workspace: workspace(),
      })
      expect(html).not.toContain('HIDDEN_ISSUE')
      expect(html).toContain('SHOWN_MR')
    } finally {
      globals.localStorage = previous
    }
  })
})
