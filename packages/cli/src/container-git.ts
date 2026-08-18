// Reading git state from INSIDE a container mounted on a task worktree.
//
// A task worktree is a LINKED git worktree (`git worktree add` under
// `.codesema/worktrees/<id>`), so its `.git` is not a directory but a one-line
// file pointing at `<repo>/.git/worktrees/<id>` — a HOST path. Mount that
// worktree alone and every git command inside the container dies with
// `fatal: not a git repository: /…/.git/worktrees/<id>`, which is exactly how
// a caged agent ends up reporting that "git isn't available in the container".
//
// The fix keeps the doctrine intact. The repo's SHARED git directory is
// mounted READ-ONLY at /gitcommon, and a generated pointer file is mounted
// over /work/.git so the worktree resolves to /gitcommon/worktrees/<id> — the
// admin dir's own `commondir` is relative, so it lands back on /gitcommon by
// itself, no GIT_DIR/GIT_COMMON_DIR pollution of the agent's environment.
// The box can therefore READ status, diff, log and blame, and cannot write a
// single object, ref or hook: commits keep happening on the host, and git
// credentials still never enter the cage.
//
// Second half of the same story: git refuses to touch a repository whose
// directory belongs to another user ("detected dubious ownership"), which the
// uid mapping of a rootless runtime can trigger at any moment. safe.directory
// only counts in PROTECTED configuration — system, global and command scope —
// so it travels as GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> (command scope,
// verified against git 2.53): per run, and therefore immune to the persistent
// $HOME volume being seeded before that config ever existed.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tryGit } from './git.js'

/** Where the repo's shared git directory is mounted, read-only. */
export const CAGE_GIT_COMMON_DIR = '/gitcommon'

/** A linked worktree's git location, split into what a container can mount. */
export type WorktreeGitLink = {
  /** HOST path of the shared git directory (the main checkout's `.git`). */
  commonDir: string
  /** The worktree's own admin dir, RELATIVE to `commonDir` (`worktrees/<id>`). */
  gitDirRelative: string
}

/**
 * What the worktree's git looks like from the host. Null — meaning "mount
 * nothing extra" — for anything that is not a linked worktree pointing INSIDE
 * its own common dir: a plain checkout already carries its `.git` directory in
 * the mount, and a non-repo has no git state to expose at all.
 */
export function resolveWorktreeGitLink(worktree: string): WorktreeGitLink | null {
  const gitDir = tryGit(['rev-parse', '--path-format=absolute', '--git-dir'], worktree)
  const commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree)
  if (!gitDir || !commonDir) {
    return null
  }
  const resolvedGitDir = resolve(gitDir)
  const resolvedCommonDir = resolve(commonDir)
  if (resolvedGitDir === resolvedCommonDir) {
    // Plain checkout: `.git` is a real directory inside the mounted worktree.
    return null
  }
  const gitDirRelative = relative(resolvedCommonDir, resolvedGitDir).split('\\').join('/')
  if (!gitDirRelative || gitDirRelative.startsWith('..') || isAbsolute(gitDirRelative)) {
    // A `--separate-git-dir` layout the pointer trick cannot describe: leave
    // the cage without git rather than mount an unrelated host directory.
    return null
  }
  return { commonDir: resolvedCommonDir, gitDirRelative }
}

/** Content of the `.git` file mounted over the worktree's own, container-side. */
export function gitPointerContent(link: WorktreeGitLink): string {
  return `gitdir: ${CAGE_GIT_COMMON_DIR}/${link.gitDirRelative}\n`
}

/**
 * safe.directory for the two paths git will look at, as `-e` arguments.
 * GIT_CONFIG_* is command scope, the only env-borne scope git counts as
 * protected — a value dropped in a config FILE under $HOME would be both
 * ignored on the first turn (the volume is seeded before it exists) and
 * unprotected.
 */
export function gitSafeDirectoryEnvArgs(workDir: string): string[] {
  return [
    '-e',
    'GIT_CONFIG_COUNT=2',
    '-e',
    'GIT_CONFIG_KEY_0=safe.directory',
    '-e',
    `GIT_CONFIG_VALUE_0=${workDir}`,
    '-e',
    'GIT_CONFIG_KEY_1=safe.directory',
    '-e',
    `GIT_CONFIG_VALUE_1=${CAGE_GIT_COMMON_DIR}`,
  ]
}

/** Stable per-worktree scratch dir for the generated pointer file. */
export function containerGitStateDir(worktree: string): string {
  const hash = createHash('sha256').update(worktree).digest('hex').slice(0, 12)
  return join(tmpdir(), `codesema-gitdir-${hash}`)
}

export type ContainerGitAccess = {
  /** `-v` arguments to splice into the run argv, both read-only. */
  mountArgs: string[]
  /** Host path of the generated `.git` pointer file. */
  pointerPath: string
  link: WorktreeGitLink
}

export type PrepareContainerGitOptions = {
  worktree: string
  /** Mount point of the worktree inside the container. */
  workDir: string
  /** Where the pointer file is written; defaults to a stable tmp dir. */
  stateDir?: string
}

/**
 * Everything a container needs to READ the worktree's git, or null when there
 * is nothing to add. Best effort by contract: a scratch dir that cannot be
 * written leaves the container exactly as it was, it never fails a turn.
 */
export function prepareContainerGit(opts: PrepareContainerGitOptions): ContainerGitAccess | null {
  const link = resolveWorktreeGitLink(opts.worktree)
  if (!link) {
    return null
  }
  const dir = opts.stateDir ?? containerGitStateDir(opts.worktree)
  const pointerPath = join(dir, 'dotgit')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(pointerPath, gitPointerContent(link))
  } catch {
    return null
  }
  return {
    mountArgs: [
      '-v',
      `${link.commonDir}:${CAGE_GIT_COMMON_DIR}:ro`,
      '-v',
      `${pointerPath}:${opts.workDir}/.git:ro`,
    ],
    pointerPath,
    link,
  }
}
