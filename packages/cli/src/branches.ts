import { currentBranch, tryGit } from './git.js'
import { t } from './i18n.js'
import { select } from './tui.js'

export type LocalBranch = {
  name: string
  lastCommitRelative: string
  subject: string
  isCurrent: boolean
  /** Path of the worktree this branch is checked out in (the main worktree counts), null otherwise. */
  worktreePath: string | null
}

export type GitWorktree = { path: string; branch: string | null }

/** Parses `git worktree list --porcelain`: paragraphs separated by a blank line, one `worktree <path>` and an
 *  optional `branch refs/heads/<name>` line each (absent when detached). */
export function listWorktrees(cwd: string): GitWorktree[] {
  const out = tryGit(['worktree', 'list', '--porcelain'], cwd)
  if (!out) return []

  const worktrees: GitWorktree[] = []
  let path: string | null = null
  let branch: string | null = null
  const flush = () => {
    if (path) worktrees.push({ path, branch })
    path = null
    branch = null
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === '') {
      flush()
    }
  }
  flush()
  return worktrees
}

export function listLocalBranches(cwd: string): LocalBranch[] {
  const out = tryGit(
    ['for-each-ref', 'refs/heads', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:relative)%09%(subject)'],
    cwd,
  )
  if (!out) return []
  const current = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  const worktreeByBranch = new Map<string, string>()
  for (const wt of listWorktrees(cwd)) {
    if (wt.branch) worktreeByBranch.set(wt.branch, wt.path)
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', lastCommitRelative = '', ...subjectParts] = line.split('\t')
      return {
        name,
        lastCommitRelative,
        subject: subjectParts.join('\t'),
        isCurrent: name === current,
        worktreePath: worktreeByBranch.get(name) ?? null,
      }
    })
    .filter((b) => b.name)
}

/** Interactive branch picker (keyboard filter). Returns null if cancelled, the current branch if non-TTY or the list is empty. */
export async function pickBranch(cwd: string): Promise<string | null> {
  const branches = listLocalBranches(cwd)
  if (branches.length <= 1) return branches[0]?.name ?? currentBranch(cwd)

  const initialIndex = Math.max(0, branches.findIndex((b) => b.isCurrent))
  const picked = await select({
    title: t('branches.pick'),
    options: branches.map((b) => ({
      label: b.isCurrent ? `${b.name} *` : b.name,
      hint: [b.lastCommitRelative, b.subject].filter(Boolean).join(' · '),
      value: b.name,
    })),
    initialIndex,
    filter: true,
  })
  return picked
}
