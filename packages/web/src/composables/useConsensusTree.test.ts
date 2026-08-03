import { describe, expect, test } from 'bun:test'
import { buildConsensusTree, type ConsensusDirNode, type ConsensusRow } from './useConsensusTree'

function row(over: Partial<ConsensusRow> & { path: string }): ConsensusRow {
  return { additions: 1, deletions: 0, a: false, b: false, hot: false, ...over }
}

function dirNamed(nodes: ReturnType<typeof buildConsensusTree>, dir: string): ConsensusDirNode {
  const found = nodes.find((n) => n.kind === 'dir' && n.dir === dir)
  if (!found || found.kind !== 'dir') {
    throw new Error(`dir ${dir} not found`)
  }
  return found
}

describe('buildConsensusTree', () => {
  test('groups files by folder, root files stay at the top level', () => {
    const tree = buildConsensusTree([
      row({ path: 'src/a.ts' }),
      row({ path: 'src/nested/b.ts' }),
      row({ path: 'README.md' }),
    ])
    expect(tree.map((n) => (n.kind === 'dir' ? n.dir : n.name))).toEqual(['src', 'README.md'])
    const src = dirNamed(tree, 'src')
    expect(src.children.map((n) => (n.kind === 'dir' ? n.dir : n.name))).toEqual(['a.ts', 'nested'])
    const nested = src.children.find(
      (n) => n.kind === 'dir' && n.dir === 'nested',
    ) as ConsensusDirNode
    expect(nested.children).toEqual([
      { kind: 'file', name: 'b.ts', row: expect.objectContaining({ path: 'src/nested/b.ts' }) },
    ])
  })

  test('a folder lights up on a lane when any descendant does, even a deeply nested one', () => {
    const tree = buildConsensusTree([row({ path: 'src/deep/nested/x.ts', a: true, b: false })])
    const src = dirNamed(tree, 'src')
    expect(src.a).toBe(true)
    expect(src.b).toBe(false)
    const deep = dirNamed(src.children, 'deep')
    expect(deep.a).toBe(true)
  })

  test('a folder turns hot when both lanes are lit anywhere below it, not necessarily the same file', () => {
    const tree = buildConsensusTree([
      row({ path: 'src/a.ts', a: true, b: false }),
      row({ path: 'src/b.ts', a: false, b: true }),
    ])
    const src = dirNamed(tree, 'src')
    expect(src.a).toBe(true)
    expect(src.b).toBe(true)
    expect(src.hot).toBe(true)
  })

  test('a folder with only one lane lit stays cold', () => {
    const tree = buildConsensusTree([row({ path: 'src/a.ts', a: true, b: false })])
    expect(dirNamed(tree, 'src').hot).toBe(false)
  })

  test('empty input yields an empty tree', () => {
    expect(buildConsensusTree([])).toEqual([])
  })
})
