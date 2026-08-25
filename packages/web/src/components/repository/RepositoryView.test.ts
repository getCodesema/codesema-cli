// Same harness as ForgeAccordion.test.ts: createSSRApp's root render function
// hands the child component its slots directly, no mount, no DOM.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import type { RepoTab } from '../../composables/useWorkspaceNav'
import { t } from '../../i18n'
import type { ForgeMr, ForgeMrStateFilter } from '../../types'
import type { ForgeSortKey } from '../forge/ForgeLogic'

const SOURCE = readFileSync(join(import.meta.dir, 'RepositoryView.vue'), 'utf8')

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

function issuesState(overrides: Partial<ProjectIssuesState> = {}): ProjectIssuesState {
  return { result: null, loading: false, error: null, ...overrides }
}

type Props = {
  projectName: string
  tab: RepoTab
  controlsCollapsed: boolean
  controlsWidth: number
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsStateFilter: ForgeMrStateFilter
  mrsDraftOnly: boolean
  mrsLabels: string[]
  listWidth: number
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    projectName: 'demo',
    tab: 'branches',
    controlsCollapsed: false,
    controlsWidth: 288,
    issuesState: issuesState(),
    issuesSort: 'updated',
    issuesLabels: [],
    mrs: [],
    mrsState: null,
    mrsSort: 'updated',
    mrsStateFilter: 'open',
    mrsDraftOnly: false,
    mrsLabels: [],
    listWidth: 320,
    ...overrides,
  }
}

async function render(
  overrides: Partial<Props> = {},
  slots: { branches?: () => string } = {},
): Promise<string> {
  const RepositoryView = (await import('./RepositoryView.vue')).default
  const app = createSSRApp({
    render: () => h(RepositoryView, props(overrides), slots),
  })
  return renderToString(app)
}

/** The rendered `<button ... id="rv-tab-{tab}">...</button>`, isolated so an
 * attribute assertion cannot accidentally match a different tab's button. */
function tabButton(html: string, tab: RepoTab): string {
  const start = html.indexOf(`id="rv-tab-${tab}"`)
  const end = html.indexOf('</button>', start)
  return html.slice(start, end)
}

describe('tab bar: all three tabs, exactly one aria-selected', () => {
  test('renders all three tab labels', async () => {
    const html = await render()
    expect(html).toContain(t('repository.tabBranches'))
    expect(html).toContain(t('repository.tabIssues'))
    expect(html).toContain(t('repository.tabMrs'))
  })

  test('carries the tablist/tab roles, one tab element per entry', async () => {
    const html = await render()
    expect(html).toContain('role="tablist"')
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3)
  })

  test.each(['branches', 'issues', 'mrs'] as const)(
    'tab %s active: only that tab is aria-selected',
    async (active) => {
      const html = await render({ tab: active })
      expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1)
      for (const value of ['branches', 'issues', 'mrs'] as const) {
        expect(tabButton(html, value)).toContain(`aria-selected="${value === active}"`)
      }
    },
  )
})

describe('branches tab: a bare shell around the #branches slot', () => {
  test('renders the slot content, full width', async () => {
    const html = await render({ tab: 'branches' }, { branches: () => 'BRANCH_TABLE_MARK' })
    expect(html).toContain('BRANCH_TABLE_MARK')
  })

  test('mounts neither the forge controls rail nor the board', async () => {
    const html = await render({ tab: 'branches' }, { branches: () => 'BRANCH_TABLE_MARK' })
    expect(html).not.toContain('fcp-root')
    expect(html).not.toContain('fb-shell')
  })
})

describe('issues and mrs tabs: the forge controls rail and board, no slot', () => {
  test.each(['issues', 'mrs'] as const)(
    'tab %s mounts both the rail and the board',
    async (tab) => {
      const html = await render({ tab }, { branches: () => 'BRANCH_TABLE_MARK' })
      expect(html).toContain('fcp-root')
      expect(html).toContain('fb-shell')
      expect(html).not.toContain('BRANCH_TABLE_MARK')
    },
  )

  test('tab issues drives both children with activeSection "issues"', async () => {
    const html = await render({ tab: 'issues' })
    expect(html).toContain('id="fcp-body-issues"')
    expect(html).not.toContain('id="fcp-body-mrs"')
  })

  test('tab mrs drives both children with activeSection "mrs"', async () => {
    const html = await render({ tab: 'mrs' })
    expect(html).toContain('id="fcp-body-mrs"')
    expect(html).not.toContain('id="fcp-body-issues"')
  })

  test('picking a section inside the rail re-emits a tab change, not a local switch', () => {
    expect(SOURCE).toContain(`@update:active-section="(section) => emit('update:tab', section)"`)
  })
})

describe('repository name', () => {
  test('shown as the view heading', async () => {
    const html = await render({ projectName: 'my-repo' })
    expect(html).toContain('class="rv-title"')
    expect(html).toContain('my-repo')
  })
})

describe('design: color is a state, never a hardcoded one', () => {
  test('the active tab is a tinted fill, no border', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('.rv-tab--active {'),
      SOURCE.indexOf('.rv-tab:focus-visible'),
    )
    expect(block).toContain('background: var(--cs-green-soft);')
    expect(block).not.toMatch(/\bborder(-\w+)?:\s*\d/)
  })

  test('every tab honors :focus-visible', () => {
    expect(SOURCE).toContain('.rv-tab:focus-visible {')
  })

  test('the style block only references --cs-* tokens, never a hardcoded color', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
  })
})

// The forge controls rail was resizable before it moved in here, and moving
// it must not quietly cost that: the handle comes back with it, and folds
// away with the rail rather than sitting against a 48px band.
describe('the forge controls rail keeps its resize handle', () => {
  test('the handle is mounted between the rail and the board, under issues', async () => {
    const html = await render(props({ tab: 'issues' }))
    expect(html).toContain(t('forge.resizeControlsAria'))
    expect(html.indexOf('fcp-root')).toBeLessThan(html.indexOf(t('forge.resizeControlsAria')))
  })

  test('a collapsed rail carries no handle at all', async () => {
    const html = await render(props({ tab: 'issues', controlsCollapsed: true }))
    expect(html).not.toContain(t('forge.resizeControlsAria'))
  })

  test('the branches tab has neither rail nor handle', async () => {
    const html = await render(props({ tab: 'branches' }))
    expect(html).not.toContain(t('forge.resizeControlsAria'))
  })
})
