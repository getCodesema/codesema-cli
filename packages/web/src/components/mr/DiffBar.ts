// Pure micro diff-bar layout: additions/deletions ratio rendered as five
// blocks. Split out of MrCard.vue so the boundary math is unit-testable on
// its own, with no SSR render involved.

export type DiffBarBlock = 'add' | 'del' | 'neutral'

const BAR_LENGTH = 5
/** As soon as there is any addition, it earns at least one green block. */
const ADD_FLOOR = 1
/** As soon as there is any deletion, additions never fill more than four of
 * the five blocks: a real deletion must never round away to nothing. */
const ADD_CEIL = 4

export function diffBarBlocks(additions: number, deletions: number): DiffBarBlock[] {
  const total = additions + deletions
  if (total <= 0) {
    return Array<DiffBarBlock>(BAR_LENGTH).fill('neutral')
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
