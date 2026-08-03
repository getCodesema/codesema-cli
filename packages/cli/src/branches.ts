import { currentBranch, tryGit } from './git.js'
import { t } from './i18n.js'
import { select } from './tui.js'

export type LocalBranch = {
  name: string
  lastCommitRelative: string
  subject: string
  isCurrent: boolean
}

export function listLocalBranches(cwd: string): LocalBranch[] {
  const out = tryGit(
    [
      'for-each-ref',
      'refs/heads',
      '--sort=-committerdate',
      '--format=%(refname:short)%09%(committerdate:relative)%09%(subject)',
    ],
    cwd,
  )
  if (!out) {
    return []
  }
  const current = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
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
      }
    })
    .filter((b) => b.name)
}

/** Interactive branch picker (keyboard filter). Returns null if cancelled, the current branch if non-TTY or the list is empty. */
export async function pickBranch(cwd: string): Promise<string | null> {
  const branches = listLocalBranches(cwd)
  if (branches.length <= 1) {
    return branches[0]?.name ?? currentBranch(cwd)
  }

  const initialIndex = Math.max(
    0,
    branches.findIndex((b) => b.isCurrent),
  )
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
