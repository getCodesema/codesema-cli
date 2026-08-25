import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { RepositoryTiles } from '../../composables/useRepository'

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

const SOURCE = readFileSync(join(import.meta.dir, 'RepositoryTiles.vue'), 'utf8')

function tiles(overrides: Partial<RepositoryTiles> = {}): RepositoryTiles {
  return {
    branchCount: 3,
    worktreeCount: 2,
    activeConversationCount: 1,
    waitingOnYouCount: 0,
    ...overrides,
  }
}

async function render(overrides: Partial<RepositoryTiles> = {}): Promise<string> {
  const Component = (await import('./RepositoryTiles.vue')).default
  const app = createSSRApp(Component, { tiles: tiles(overrides) })
  return renderToString(app)
}

describe('RepositoryTiles: the four labels', () => {
  test('renders all four tile labels', async () => {
    const html = await render()
    expect(html).toContain('Branches')
    expect(html).toContain('Worktrees')
    expect(html).toContain('Conversations')
    expect(html).toContain('Needs you')
  })
})

describe('RepositoryTiles: values', () => {
  test('renders each counter as a distinct digit', async () => {
    const html = await render({
      branchCount: 41,
      worktreeCount: 33,
      activeConversationCount: 27,
      waitingOnYouCount: 19,
    })
    expect(html).toContain('41')
    expect(html).toContain('33')
    expect(html).toContain('27')
    expect(html).toContain('19')
  })

  test('a zero counter renders as the digit 0, never a dash', async () => {
    const html = await render({
      branchCount: 0,
      worktreeCount: 0,
      activeConversationCount: 0,
      waitingOnYouCount: 0,
    })
    expect(html).not.toContain('–')
    expect((html.match(/>0</g) ?? []).length).toBe(4)
  })
})

describe('RepositoryTiles: the needs-you amber', () => {
  test('carries the attention class when its count is non-zero', async () => {
    const html = await render({ waitingOnYouCount: 3 })
    expect(html).toContain('rpt-tile--attention')
  })

  test('stays neutral when its count is zero', async () => {
    const html = await render({ waitingOnYouCount: 0 })
    expect(html).not.toContain('rpt-tile--attention')
  })

  test('the other three tiles never carry the attention class', async () => {
    const html = await render({
      branchCount: 50,
      worktreeCount: 50,
      activeConversationCount: 50,
      waitingOnYouCount: 0,
    })
    expect((html.match(/rpt-tile--attention/g) ?? []).length).toBe(0)
  })
})

describe('RepositoryTiles: design tokens', () => {
  test('no hex literal color was introduced: every color is a --cs-* token', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
  })
})
