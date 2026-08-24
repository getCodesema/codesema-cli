// Same harness as the forge board tests. The menu track's own geometry
// (236px, an inner card, a footer hairline) lives in the scoped <style>
// block, which this SSR-string render never sees (same limitation as
// everywhere else in this harness): the pixel values are pinned on the raw
// source, like WorkspaceView.test.ts does for its own non-mountable
// concerns. Structure (which wrapper holds what) is checked on the actual
// render.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ConversationNode, ProjectActivity } from '../composables/useProjects'
import type { Project, ProjectCandidate } from '../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'ProjectsNav.vue'), 'utf8')

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    path: '/repo/one',
    name: 'one',
    added_at: '2026-08-14T00:00:00.000Z',
    ...overrides,
  }
}

type Props = {
  projects: Project[]
  selected: string | null
  activity: ReadonlyMap<string, ProjectActivity>
  tree: ConversationNode[]
  extraBranches: string[]
  focusedKeys: readonly string[]
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
    tree: [],
    extraBranches: [],
    focusedKeys: [],
    addBusy: false,
    addError: null,
    removeError: null,
    candidates: [],
    ...overrides,
  }
}

async function render(p: Partial<Props> = {}): Promise<string> {
  const ProjectsNav = (await import('./ProjectsNav.vue')).default
  const app = createSSRApp(ProjectsNav, props(p))
  return renderToString(app)
}

describe('menu geometry: pixel-accurate track and row dimensions', () => {
  test('the track is 236px wide, not the earlier 210px', () => {
    expect(SOURCE).toContain('width: 236px;')
    expect(SOURCE).not.toContain('width: 210px;')
  })

  test('the collapsed-rail width (74px) is documented as out of scope, not silently dropped', () => {
    expect(SOURCE).toContain('74px')
  })

  test('the nav row is 36px tall, 12px/8px padding, 8px radius', () => {
    expect(SOURCE).toContain('height: 36px;')
    expect(SOURCE).toContain('padding: 8px 12px;')
  })

  test('the group subheader is 13px/500, no uppercase transform any more', () => {
    // Scoped to `.pn-label` itself: `.pn-detected-label` (the add-form's own
    // "Detected repos" caption) is a different element, untouched by this
    // spec point, and still legitimately uppercase.
    const groupLabel = SOURCE.slice(
      SOURCE.indexOf('.pn-label {'),
      SOURCE.indexOf('.pn-label--inline'),
    )
    expect(groupLabel).toContain('font-size: 13px;')
    expect(groupLabel).toContain('font-weight: 500;')
    expect(groupLabel).not.toContain('text-transform: uppercase;')
  })

  test('the count pastille is a filled pill: min-width 18px, height 16px, full radius, 12px bold', () => {
    expect(SOURCE).toContain('min-width: 18px;')
    expect(SOURCE).toContain('height: 16px;')
    expect(SOURCE).toContain('border-radius: 999px;')
    expect(SOURCE).toContain('font-size: 12px;')
    expect(SOURCE).toContain('font-weight: 700;')
  })

  test('the active states carry no border or side bar: background and text only', () => {
    const allActive = SOURCE.slice(
      SOURCE.indexOf('.pn-all--active {'),
      SOURCE.indexOf('.pn-count-pill {'),
    )
    expect(allActive).not.toContain('border-color')
    const projectActive = SOURCE.slice(
      SOURCE.indexOf('.pn-project--active {'),
      SOURCE.indexOf('/* The icon slot'),
    )
    expect(projectActive).not.toContain('border-color')
  })

  test('no hex literal was introduced: every color is a --cs-* token', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
  })

  test('the menu footer is set off by a hairline above it', () => {
    expect(SOURCE).toContain('.pn-footer {')
    const footer = SOURCE.slice(SOURCE.indexOf('.pn-footer {'), SOURCE.indexOf('.pn-add {'))
    expect(footer).toContain('border-top: 1px solid')
  })
})

describe('structure: the card/list/footer wrappers actually exist in the render', () => {
  test('the inner card wraps the whole menu body', async () => {
    const html = await render()
    expect(html).toContain('class="pn-card"')
  })

  test('project rows are grouped in their own list wrapper', async () => {
    const html = await render({
      projects: [project({ id: 'a' }), project({ id: 'b', name: 'two' })],
    })
    expect(html).toContain('class="pn-list"')
    expect(html).toContain('one')
    expect(html).toContain('two')
  })

  test('the add-project control sits inside the footer wrapper', async () => {
    const html = await render()
    const footerAt = html.indexOf('class="pn-footer"')
    const addAt = html.indexOf('class="pn-add"')
    expect(footerAt).toBeGreaterThan(-1)
    expect(addAt).toBeGreaterThan(footerAt)
  })
})
