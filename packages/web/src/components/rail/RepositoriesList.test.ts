// Same harness as ProjectsNav.test.ts, this component's own source and
// closest relative. Two families of state live behind internal refs with no
// prop entry point (formOpen, confirmRemoveId): opening the add-form or
// arming a removal requires a click, which an SSR string render cannot
// simulate — ProjectsNav.test.ts's own suite has the identical gap for the
// identical reason (it never opens its own add-form or arms a removal
// either). Those branches are pinned on the raw source below instead of
// exercised by a render, same fallback this whole file family already uses
// for CSS-only facts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ProjectActivity } from '../../composables/useProjects'
import { t } from '../../i18n'
import type { Project, ProjectCandidate } from '../../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'RepositoriesList.vue'), 'utf8')

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    path: '/repo/one',
    name: 'one',
    kind: 'repo',
    added_at: '2026-08-14T00:00:00.000Z',
    ...overrides,
  }
}

type Props = {
  projects: Project[]
  selected: string | null
  activity: ReadonlyMap<string, ProjectActivity>
  addBusy: boolean
  addError: string | null
  removeError: string | null
  candidates: ProjectCandidate[]
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    projects: [project()],
    selected: null,
    activity: new Map(),
    addBusy: false,
    addError: null,
    removeError: null,
    candidates: [],
    ...overrides,
  }
}

async function render(overrides: Partial<Props> = {}): Promise<string> {
  const RepositoriesList = (await import('./RepositoriesList.vue')).default
  const app = createSSRApp(RepositoriesList, props(overrides))
  return renderToString(app)
}

describe('header: title and a count that reflects the registry size', () => {
  test('the title renders', async () => {
    const html = await render()
    expect(html).toContain(t('rail.repositoriesTitle'))
  })

  test('the count matches the number of registered projects, not a filtered one', async () => {
    const html = await render({
      projects: [project({ id: 'a' }), project({ id: 'b', name: 'two' })],
    })
    expect(html).toMatch(/class="rpl-count">2</)
  })
})

describe('empty vs. non-empty registry', () => {
  test('no project registered: the empty message, no rows', async () => {
    const html = await render({ projects: [] })
    expect(html).toContain(t('rail.repositoriesEmpty'))
    expect(html).not.toContain('class="rpl-project"')
  })

  test('projects registered: no empty message, one row per project', async () => {
    const html = await render({
      projects: [project({ id: 'a', name: 'one' }), project({ id: 'b', name: 'two' })],
    })
    expect(html).not.toContain(t('rail.repositoriesEmpty'))
    expect(html).toContain('one')
    expect(html).toContain('two')
    expect((html.match(/class="rpl-project"/g) ?? []).length).toBe(2)
  })
})

describe('search: no-match message wiring (query is internal state, not a prop — pinned on source)', () => {
  test('the search input and placeholder render', async () => {
    const html = await render()
    expect(html).toContain(t('rail.repositoriesSearchPlaceholder'))
    expect(html).not.toContain('rpl-search-clear')
    expect(html).toContain('padding-right:36px')
  })

  test('the no-match branch is wired to its own key, distinct from the empty-registry one', () => {
    expect(SOURCE).toContain("t('rail.repositoriesSearchEmpty')")
    expect(SOURCE).toContain('v-else-if="isSearchEmpty"')
  })

  test('the filter matches by project name only, never reaching into the detected candidates', () => {
    expect(SOURCE).toContain('project.name.toLowerCase().includes(needle)')
  })
})

describe('selection: the active repository is a tinted fill, never a border', () => {
  test('the selected project carries the active class, the others do not', async () => {
    const html = await render({
      projects: [project({ id: 'a', name: 'one' }), project({ id: 'b', name: 'two' })],
      selected: 'b',
    })
    const rows = [...html.matchAll(/<button type="button" class="rpl-project[^"]*"([^>]*)>/g)]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.[0]).not.toContain('rpl-project--active')
    expect(rows[1]?.[0]).toContain('rpl-project--active')
    expect(rows[0]?.[1]).toContain('aria-pressed="false"')
    expect(rows[1]?.[1]).toContain('aria-pressed="true"')
  })

  test('nothing selected: no row carries the active class', async () => {
    const html = await render({ projects: [project({ id: 'a' })], selected: null })
    expect(html).not.toContain('rpl-project--active')
  })

  test('the active rule is a tinted fill, no border property', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.rpl-project--active {'),
      SOURCE.indexOf('.rpl-icon-slot {'),
    )
    expect(rule).toContain('background: var(--cs-green-soft);')
    expect(rule).not.toContain('border-color')
  })
})

describe('activity badges: waiting (strong amber) and running (plain amber count)', () => {
  test('no activity: no badge renders', async () => {
    const html = await render({ projects: [project({ id: 'a' })], activity: new Map() })
    expect(html).not.toContain('rpl-badge--waiting')
    expect(html).not.toContain('rpl-badge--running')
  })

  test('waiting > 0: the waiting badge renders with its count', async () => {
    const html = await render({
      projects: [project({ id: 'a' })],
      activity: new Map([['a', { waiting: 2, active: 0 }]]),
    })
    expect(html).toContain('rpl-badge--waiting')
    expect(html).toContain('2')
  })

  test('active > 0: the running badge renders with its count', async () => {
    const html = await render({
      projects: [project({ id: 'a' })],
      activity: new Map([['a', { waiting: 0, active: 5 }]]),
    })
    expect(html).toContain('rpl-badge--running')
    expect(html).toContain('5')
  })
})

describe('removal: hidden until interaction, double-click arm pattern preserved from ProjectsNav.vue', () => {
  test('the remove button is present but unarmed by default', async () => {
    const html = await render({ projects: [project({ id: 'a' })] })
    expect(html).toContain('class="rpl-remove"')
    expect(html).not.toContain('rpl-remove--armed')
  })

  test('the first click arms the confirmation, the second fires `remove` (source-pinned: requestRemove)', () => {
    expect(SOURCE).toContain('function requestRemove(id: string): void {')
    const fn = SOURCE.slice(
      SOURCE.indexOf('function requestRemove(id: string): void {'),
      SOURCE.indexOf('</script>'),
    )
    expect(fn).toContain("emit('remove', id)")
    expect(fn).toContain('confirmRemoveId.value = id')
  })

  test('armed styling is red, doctrine not decoration', () => {
    const rule = SOURCE.slice(
      SOURCE.indexOf('.rpl-remove--armed {'),
      SOURCE.indexOf('.rpl-remove--armed {') + 150,
    )
    expect(rule).toContain('var(--cs-red-text)')
  })
})

describe('add-project entry point: closed by default, the form itself needs a click (source-pinned)', () => {
  test('the closed-state button renders, the form does not', async () => {
    const html = await render()
    expect(html).toContain(t('workspace.addProject'))
    expect(html).not.toContain('rpl-add-form')
  })

  test('opening the form asks the parent to (re)discover candidates', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('function openForm(): void {'),
      SOURCE.indexOf('/** Detected'),
    )
    expect(fn).toContain("emit('discover')")
  })

  test('offerable candidates exclude already-registered ones', () => {
    expect(SOURCE).toContain('props.candidates.filter((candidate) => !candidate.registered)')
  })

  test('the add-error message is wired inside the form, keyed off the addError prop', () => {
    expect(SOURCE).toContain("t('workspace.addProjectError')")
    expect(SOURCE).toContain('v-if="addError"')
  })

  test('a remove-error renders outside the form, independent of formOpen', async () => {
    const html = await render({ removeError: 'network down' })
    expect(html).toContain(t('workspace.removeProjectError'))
    expect(html).toContain('network down')
  })
})

describe('root: no fixed width, matches ConversationsList.vue as a swappable slot', () => {
  test('the root style carries no width/min-width/max-width pixel values', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.rpl-root {'), SOURCE.indexOf('.rpl-header {'))
    expect(root).not.toMatch(/\bwidth:\s*\d+px/)
    expect(root).not.toContain('min-width:')
    expect(root).not.toContain('max-width:')
    expect(root).toContain('width: 100%;')
  })

  test('the same card treatment as ConversationsList.vue: radius, border, shadow', () => {
    const root = SOURCE.slice(SOURCE.indexOf('.rpl-root {'), SOURCE.indexOf('.rpl-header {'))
    expect(root).toContain('border-radius: 16px;')
    expect(root).toContain('box-shadow: var(--cs-shadow-panel);')
  })
})

describe('rows carry no border: explicit, never a bare omission', () => {
  test('a repository row declares border: none', () => {
    const block = SOURCE.slice(
      SOURCE.indexOf('.rpl-project {'),
      SOURCE.indexOf('.rpl-project:hover'),
    )
    expect(block).toContain('border: none;')
  })

  test('no hex literal was introduced: every color is a --cs-* token', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
  })
})

describe('no "All projects" entry: this list only ever emits a concrete id', () => {
  test('the select emit type is a plain string, never null (no row here would emit it)', () => {
    expect(SOURCE).toContain('select: [id: string]')
  })

  test('no LayoutGrid / all-projects affordance was carried over', () => {
    expect(SOURCE).not.toContain('LayoutGrid')
    expect(SOURCE).not.toContain('allProjects')
  })
})
