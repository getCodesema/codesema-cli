// Pure micro diff-bar layout: additions/deletions ratio rendered as five
// blocks. Split out of MrCard.vue so the boundary math is unit-testable on
// its own, with no SSR render involved.

export type DiffBarBlock = 'add' | 'del'

const BAR_LENGTH = 5
/** As soon as there is any addition, it earns at least one green block. */
const ADD_FLOOR = 1
/** As soon as there is any deletion, additions never fill more than four of
 * the five blocks: a real deletion must never round away to nothing. */
const ADD_CEIL = 4

/**
 * `null` at a measured zero/zero: every rendered block is green or red, there
 * is no neutral block to fall back to, so the bar itself has nothing honest
 * left to show and disappears instead.
 */
export function diffBarBlocks(additions: number, deletions: number): DiffBarBlock[] | null {
  const total = additions + deletions
  if (total <= 0) {
    return null
  }
  let addCount = Math.round((additions / total) * BAR_LENGTH)
  if (additions > 0) {
    addCount = Math.max(addCount, ADD_FLOOR)
  }
  if (deletions > 0) {
    addCount = Math.min(addCount, ADD_CEIL)
  }
  addCount = Math.min(BAR_LENGTH, Math.max(0, addCount))
  return [
    ...Array<DiffBarBlock>(addCount).fill('add'),
    ...Array<DiffBarBlock>(BAR_LENGTH - addCount).fill('del'),
  ]
}
