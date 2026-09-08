import type { TaskRecord } from './types'

const TASK_BRANCH_PREFIX = 'codesema/task-'
const COLLISION_SUFFIX = /-\d+$/

// The agent names the branch on its first turn with a three-to-five word
// slug, which makes a better short label than the free-form title.
export function conversationLabel(record: Pick<TaskRecord, 'title' | 'branch'>): string {
  if (!record.branch.startsWith(TASK_BRANCH_PREFIX)) {
    return record.title
  }
  const slug = record.branch.slice(TASK_BRANCH_PREFIX.length).replace(COLLISION_SUFFIX, '')
  const words = slug.split('-').filter(Boolean)
  return words.length > 0 ? words.join(' ') : record.title
}
