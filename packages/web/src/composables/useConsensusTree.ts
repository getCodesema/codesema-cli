// Folder grouping for the dual consensus map's tree mode, mirroring FileTree.vue's
// buildTree algorithm; lane touch state aggregates upward from files to folders.

export type ConsensusRow = {
  path: string
  additions: number
  deletions: number
  a: boolean
  b: boolean
  hot: boolean
}

export type ConsensusFileLeaf = { kind: 'file'; name: string; row: ConsensusRow }

export type ConsensusDirNode = {
  kind: 'dir'
  dir: string
  children: ConsensusNode[]
  a: boolean
  b: boolean
  hot: boolean
}

export type ConsensusNode = ConsensusFileLeaf | ConsensusDirNode

type MutableDir = { kind: 'dir'; dir: string; children: (ConsensusFileLeaf | MutableDir)[] }

function decorate(node: MutableDir): ConsensusDirNode {
  const children: ConsensusNode[] = node.children.map((c) => (c.kind === 'dir' ? decorate(c) : c))
  const a = children.some((c) => (c.kind === 'dir' ? c.a : c.row.a))
  const b = children.some((c) => (c.kind === 'dir' ? c.b : c.row.b))
  return { kind: 'dir', dir: node.dir, children, a, b, hot: a && b }
}

/**
 * A folder lights up on a lane when ANY descendant file does; it turns hot when
 * both lanes are lit somewhere below it, not necessarily on the same file.
 */
export function buildConsensusTree(rows: ConsensusRow[]): ConsensusNode[] {
  const root: MutableDir = { kind: 'dir', dir: '', children: [] }

  for (const row of rows) {
    const parts = row.path.split('/')
    const name = parts.at(-1) ?? row.path
    let node = root
    for (const seg of parts.slice(0, -1)) {
      let child = node.children.find((c): c is MutableDir => c.kind === 'dir' && c.dir === seg)
      if (!child) {
        child = { kind: 'dir', dir: seg, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({ kind: 'file', name, row })
  }

  return root.children.map((c) => (c.kind === 'dir' ? decorate(c) : c))
}
