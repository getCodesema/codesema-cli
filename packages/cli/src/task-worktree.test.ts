import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { refExists, tryGit } from './git.js'
import {
  branchCheckoutPath,
  BranchInUseError,
  createTaskWorktree,
  detectTaskBase,
  removeTaskWorktree,
  renameTaskBranch,
  taskWorktreePath,
} from './task-worktree.js'
import { acquireWorktreeLock, worktreeLockPath } from './worktree-lock.js'

const cleanups: string[] = []
const openLocks: { release: () => void }[] = []

function makeRepo(defaultBranch = 'main'): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-wt-'))
  cleanups.push(repo)
  const run = (args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  run(['init', '-b', defaultBranch])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

afterEach(() => {
  for (const lock of openLocks.splice(0)) {
    lock.release()
  }
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('detectTaskBase', () => {
  test('origin/HEAD wins when the remote default branch is known', () => {
    const repo = makeRepo('main')
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: repo })
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
      cwd: repo,
    })
    // Identity is the SHORT name: origin/HEAD names origin/main, the base is 'main'.
    expect(detectTaskBase(repo)).toBe('main')
  })

  test('falls back to develop before main', () => {
    const repo = makeRepo('main')
    execFileSync('git', ['branch', 'develop'], { cwd: repo })
    expect(detectTaskBase(repo)).toBe('develop')
  })

  test('plain main-only repo resolves to main', () => {
    expect(detectTaskBase(makeRepo('main'))).toBe('main')
  })

  test('throws a readable error when no candidate exists', () => {
    const repo = makeRepo('trunk')
    expect(() => detectTaskBase(repo)).toThrow(/base branch/)
  })
})

describe('createTaskWorktree', () => {
  test('creates the branch from the base and checks it out under .codesema/worktrees/<id>', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'Fix the bug!')
    expect(wt.base).toBe('main')
    expect(wt.branch).toBe('codesema/task-fix-the-bug')
    expect(wt.worktree).toBe(taskWorktreePath(repo, 'aaaabbbbcccc'))
    expect(existsSync(join(wt.worktree, 'base.txt'))).toBe(true)
    expect(refExists('refs/heads/codesema/task-fix-the-bug', repo)).toBe(true)
    // The main worktree keeps its checkout: the task branch is only in the task worktree.
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).toBe('main')
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.worktree)).toBe(
      'codesema/task-fix-the-bug',
    )
  })

  test('an unusable title still yields a branch name', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', '!!! ???')
    expect(wt.branch).toBe('codesema/task-task')
  })

  test('accented titles transliterate instead of losing letters', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'Réponds-moi : où est l’été ?')
    expect(wt.branch).toBe('codesema/task-reponds-moi-ou-est-l-ete')
  })

  test('a long title is capped on a word boundary', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(
      repo,
      'aaaabbbbcccc',
      'mets à jour toute la documentation du workspace avec les derniers commits',
    )
    expect(wt.branch).toBe('codesema/task-mets-a-jour-toute-la-documentation-du')
    const wt2 = await createTaskWorktree(repo, 'ddddeeeeffff', 'x'.repeat(60))
    expect(wt2.branch).toBe(`codesema/task-${'x'.repeat(40)}`)
  })

  test('a branch name collision gets a numeric suffix', async () => {
    const repo = makeRepo('main')
    execFileSync('git', ['branch', 'codesema/task-fix-the-bug'], { cwd: repo })
    execFileSync('git', ['branch', 'codesema/task-fix-the-bug-2'], { cwd: repo })
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'Fix the bug')
    expect(wt.branch).toBe('codesema/task-fix-the-bug-3')
  })

  test('an explicit base branches from IT, not from the detected default', async () => {
    const repo = makeRepo('main')
    const run = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: repo,
        stdio: 'ignore',
      })
    // A branch whose content diverges from main, checked back out of.
    run(['checkout', '-b', 'feature'])
    writeFileSync(join(repo, 'feature.txt'), 'f\n')
    run(['add', '-A'])
    run(['commit', '-m', 'feat: feature file'])
    run(['checkout', 'main'])
    const featureSha = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo })
      .toString()
      .trim()

    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'from feature', { base: 'feature' })
    expect(wt.base).toBe('feature')
    // The worktree starts at feature's commit: its extra file is there and
    // the task branch head IS the feature head.
    expect(existsSync(join(wt.worktree, 'feature.txt'))).toBe(true)
    expect(tryGit(['rev-parse', 'HEAD'], wt.worktree)).toBe(featureSha)

    // Auto-detection is untouched: without a base the task branches from main,
    // which never had the feature file.
    const auto = await createTaskWorktree(repo, 'ddddeeeeffff', 'from default')
    expect(auto.base).toBe('main')
    expect(existsSync(join(auto.worktree, 'feature.txt'))).toBe(false)
  })

  test('an unknown explicit base throws BEFORE anything is created', async () => {
    const repo = makeRepo('main')
    await expect(
      createTaskWorktree(repo, 'aaaabbbbcccc', 'nope task', { base: 'nope' }),
    ).rejects.toThrow(/nope/)
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
    expect(refExists('refs/heads/codesema/task-nope-task', repo)).toBe(false)
  })

  test('an option-lookalike base never reaches git as a flag', async () => {
    const repo = makeRepo('main')
    // refs/heads/-evil does not exist: the refExists guard throws first.
    await expect(
      createTaskWorktree(repo, 'aaaabbbbcccc', 'evil', { base: '-evil' }),
    ).rejects.toThrow()
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test('two tasks with the same title get distinct branches and worktrees', async () => {
    const repo = makeRepo('main')
    const first = await createTaskWorktree(repo, 'aaaabbbbcccc', 'same title')
    const second = await createTaskWorktree(repo, 'ddddeeeeffff', 'same title')
    expect(first.branch).toBe('codesema/task-same-title')
    expect(second.branch).toBe('codesema/task-same-title-2')
    expect(first.worktree).not.toBe(second.worktree)
    expect(existsSync(second.worktree)).toBe(true)
  })
})

/** A repo with a 'feature' branch that is NOT checked out anywhere. */
function makeRepoWithFeature(): { repo: string; featureSha: string } {
  const repo = makeRepo('main')
  const run = (args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  run(['checkout', '-b', 'feature'])
  writeFileSync(join(repo, 'feature.txt'), 'f\n')
  run(['add', '-A'])
  run(['commit', '-m', 'feat: feature file'])
  run(['checkout', 'main'])
  const featureSha = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo }).toString().trim()
  return { repo, featureSha }
}

describe('branchCheckoutPath', () => {
  test('the MAIN worktree counts; a free branch is null', () => {
    const { repo } = makeRepoWithFeature()
    expect(branchCheckoutPath(repo, 'main')).not.toBeNull()
    expect(branchCheckoutPath(repo, 'feature')).toBeNull()
  })
})

describe('createTaskWorktree (work-on mode)', () => {
  test('checks the branch ITSELF out: commits in the worktree land on refs/heads/<branch>', async () => {
    const { repo, featureSha } = makeRepoWithFeature()
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'Work on feature', {
      branch: 'feature',
    })
    expect(wt.branch).toBe('feature')
    expect(wt.worktree).toBe(taskWorktreePath(repo, 'aaaabbbbcccc'))
    // The worktree IS the branch: no derived codesema/task-* ref anywhere.
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.worktree)).toBe('feature')
    expect(tryGit(['rev-parse', 'HEAD'], wt.worktree)).toBe(featureSha)
    expect(refExists('refs/heads/codesema/task-work-on-feature', repo)).toBe(false)
    // A commit made in the worktree (as the runner does at end of turn)
    // advances the branch itself, visible from the main repo.
    writeFileSync(join(wt.worktree, 'work.txt'), 'w\n')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {
      cwd: wt.worktree,
      stdio: 'ignore',
    })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'task: work'],
      { cwd: wt.worktree, stdio: 'ignore' },
    )
    expect(tryGit(['rev-parse', 'refs/heads/feature'], repo)).toBe(
      tryGit(['rev-parse', 'HEAD'], wt.worktree),
    )
    expect(tryGit(['rev-parse', 'refs/heads/feature'], repo)).not.toBe(featureSha)
  })

  test('an unknown branch throws BEFORE anything is created', async () => {
    const repo = makeRepo('main')
    await expect(
      createTaskWorktree(repo, 'aaaabbbbcccc', 'nope', { branch: 'ghost' }),
    ).rejects.toThrow(/ghost/)
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test('a branch checked out in the MAIN worktree is a typed conflict, no residue', async () => {
    const repo = makeRepo('main')
    let caught: unknown
    try {
      await createTaskWorktree(repo, 'aaaabbbbcccc', 'steal main', { branch: 'main' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BranchInUseError)
    expect((caught as BranchInUseError).branch).toBe('main')
    // Compared through the same lens (git may print a resolved tmpdir path).
    expect((caught as BranchInUseError).worktreePath).toBe(branchCheckoutPath(repo, 'main') ?? '')
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test('a branch checked out in a SECONDARY worktree conflicts too, no residue', async () => {
    const { repo } = makeRepoWithFeature()
    const other = join(repo, '.codesema', 'other-checkout')
    execFileSync('git', ['worktree', 'add', other, 'feature'], { cwd: repo, stdio: 'ignore' })
    await expect(
      createTaskWorktree(repo, 'aaaabbbbcccc', 'busy branch', { branch: 'feature' }),
    ).rejects.toThrow(BranchInUseError)
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test("the task's OWN stale worktree does not block re-materialization on the same branch", async () => {
    const { repo } = makeRepoWithFeature()
    const first = await createTaskWorktree(repo, 'aaaabbbbcccc', 'Work on feature', {
      branch: 'feature',
    })
    // Simulate a crash: the directory vanishes but git still registers it —
    // the branch would look checked out without the stale cleanup.
    rmSync(first.worktree, { recursive: true, force: true })
    const again = await createTaskWorktree(repo, 'aaaabbbbcccc', 'Work on feature', {
      branch: 'feature',
    })
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], again.worktree)).toBe('feature')
  })
})

describe('removeTaskWorktree', () => {
  test('removes the worktree, keeps the branch by default', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'cleanup me')
    await removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, { deleteBranch: false })
    expect(existsSync(wt.worktree)).toBe(false)
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(true)
  })

  test('deleteBranch also drops the branch', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'cleanup me')
    await removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, { deleteBranch: true })
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(false)
  })

  test('best-effort: removing a task that never had a worktree does not throw', async () => {
    const repo = makeRepo('main')
    await expect(
      removeTaskWorktree(repo, 'ffffffffffff', 'codesema/task-none', { deleteBranch: true }),
    ).resolves.toEqual({ serialized: true })
  })
})

describe('renameTaskBranch', () => {
  test('renames the fork and the worktree keeps committing on it', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'les docs sont à jours ?')
    expect(wt.branch).toBe('codesema/task-les-docs-sont-a-jours')

    const next = renameTaskBranch(repo, 'aaaabbbbcccc', wt.branch, 'update-workspace-docs')
    expect(next).toBe('codesema/task-update-workspace-docs')
    expect(refExists('refs/heads/codesema/task-les-docs-sont-a-jours', repo)).toBe(false)
    expect(refExists('refs/heads/codesema/task-update-workspace-docs', repo)).toBe(true)
    // The linked worktree followed the rename: HEAD still points at the branch.
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], wt.worktree)).toBe(
      'codesema/task-update-workspace-docs',
    )
    writeFileSync(join(wt.worktree, 'after.txt'), 'x\n')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {
      cwd: wt.worktree,
    })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'after'], {
      cwd: wt.worktree,
      stdio: 'ignore',
    })
    expect(tryGit(['log', '-1', '--pretty=%s', 'codesema/task-update-workspace-docs'], repo)).toBe(
      'after',
    )
  })

  test('the proposal is slugged and collisions get the same numeric suffix as creation', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'first title')
    execFileSync('git', ['branch', 'codesema/task-fix-preview-rename'], { cwd: repo })
    expect(renameTaskBranch(repo, 'aaaabbbbcccc', wt.branch, 'Fix Preview Rename')).toBe(
      'codesema/task-fix-preview-rename-2',
    )
  })

  test('a work-on branch (not a codesema/task-* fork) is never renamed', () => {
    const repo = makeRepo('main')
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo })
    expect(renameTaskBranch(repo, 'aaaabbbbcccc', 'feature/mine', 'nicer-name')).toBeNull()
    expect(refExists('refs/heads/feature/mine', repo)).toBe(true)
    expect(refExists('refs/heads/codesema/task-nicer-name', repo)).toBe(false)
  })

  test('a branch already pushed keeps its published name', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'shipped work')
    execFileSync('git', ['update-ref', `refs/remotes/origin/${wt.branch}`, wt.branch], {
      cwd: repo,
    })
    expect(renameTaskBranch(repo, 'aaaabbbbcccc', wt.branch, 'much-better-name')).toBeNull()
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(true)
  })

  test('an unusable or identical proposal is a no-op', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'keep me')
    expect(renameTaskBranch(repo, 'aaaabbbbcccc', wt.branch, '!!! ???')).toBeNull()
    expect(renameTaskBranch(repo, 'aaaabbbbcccc', wt.branch, 'Keep me')).toBeNull()
    expect(refExists('refs/heads/codesema/task-keep-me', repo)).toBe(true)
  })
})

describe('branch identity unification (origin/x === x)', () => {
  test("an explicit base 'origin/<name>' normalizes to the short identity", async () => {
    const repo = makeRepo()
    const made = await createTaskWorktree(repo, 'aaaaaaaaaaa1', 'from origin base', {
      base: 'origin/main',
    })
    // No refs/remotes here: 'origin/main' resolves to the LOCAL main head.
    expect(made.base).toBe('main')
    expect(made.branch.startsWith('codesema/task-')).toBe(true)
  })

  test('work-on a remote-only branch creates the local tracking head, same identity', async () => {
    const repo = makeRepo()
    // Simulate a teammate's branch never pulled: a remote-tracking ref only.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/feature/remote-only', 'main'], {
      cwd: repo,
    })
    const made = await createTaskWorktree(repo, 'aaaaaaaaaaa2', 'work on remote', {
      branch: 'feature/remote-only',
    })
    expect(made.branch).toBe('feature/remote-only')
    expect(refExists('refs/heads/feature/remote-only', repo)).toBe(true)
  })

  test('fork from a remote-only base works too', async () => {
    const repo = makeRepo()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/only-remote', 'main'], { cwd: repo })
    const made = await createTaskWorktree(repo, 'aaaaaaaaaaa3', 'fork remote base', {
      base: 'only-remote',
    })
    expect(made.base).toBe('only-remote')
  })
})

// --- baseline: where the conversation starts from ---------------------------

/** Leaves the repo with a modified tracked file and untracked ones. */
function dirtyUp(repo: string): void {
  writeFileSync(join(repo, 'base.txt'), 'a\nlocal edit\n')
  writeFileSync(join(repo, 'scratch.txt'), 'personal notes\n')
}

describe('createTaskWorktree (baseline)', () => {
  test('the baseline IS the start point, and no commit is created for it', async () => {
    const repo = makeRepo('main')
    const mainSha = tryGit(['rev-parse', 'refs/heads/main'], repo)

    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'anchored task')

    expect(wt.baseline).toBe(mainSha ?? '')
    expect(tryGit(['diff', '--name-only', `${wt.baseline}..HEAD`], wt.worktree)).toBe('')
    // Nothing was committed anywhere: not on the task branch, not on the base.
    expect(tryGit(['log', '--pretty=%s'], wt.worktree)).toBe('init: base')
    expect(tryGit(['rev-parse', 'refs/heads/main'], repo)).toBe(mainSha ?? '')
    expect(tryGit(['rev-parse', `refs/heads/${wt.branch}`], repo)).toBe(wt.baseline)
  })

  test('uncommitted work stays in the checkout: not carried, but COUNTED', async () => {
    const repo = makeRepo('main')
    dirtyUp(repo)
    const before = tryGit(['status', '--porcelain'], repo)

    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'clean start')

    // The agent starts from a committed point, not from someone's work in
    // progress — the private WIP never enters a branch that may be pushed.
    expect(readFileSync(join(wt.worktree, 'base.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(wt.worktree, 'scratch.txt'))).toBe(false)
    // …and the fact is handed back so the human can be told, once.
    expect(wt.uncommitted_files).toBe(2)
    // The checkout is exactly as it was: nothing stashed, moved or added.
    expect(tryGit(['status', '--porcelain'], repo)).toBe(before)
    expect(tryGit(['stash', 'list'], repo)).toBe('')
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('a\nlocal edit\n')
  })

  test('a clean checkout has nothing to report', async () => {
    const repo = makeRepo('main')
    expect((await createTaskWorktree(repo, 'aaaabbbbcccc', 'quiet start')).uncommitted_files).toBe(
      0,
    )
  })

  test("after a turn, baseline..HEAD is EXACTLY the agent's work", async () => {
    const repo = makeRepo('main')
    dirtyUp(repo)
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'measured work')

    writeFileSync(join(wt.worktree, 'agent.txt'), 'the work\n')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {
      cwd: wt.worktree,
    })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'turn 1'], {
      cwd: wt.worktree,
      stdio: 'ignore',
    })

    const changed = (tryGit(['diff', '--name-only', `${wt.baseline}..HEAD`], wt.worktree) ?? '')
      .split('\n')
      .filter(Boolean)
    expect(changed).toEqual(['agent.txt'])
    // The edit the human left in their checkout is nobody's work but theirs.
    expect(changed).not.toContain('base.txt')
  })

  test('a fork whose worktree VANISHED can be rebuilt: the dangling registration is pruned', async () => {
    const repo = makeRepo('main')
    const first = await createTaskWorktree(repo, 'aaaabbbbcccc', 'crashed fork')
    // Simulate a crash: the directory is gone, git still registers it. Without
    // pruning, `worktree add` refuses and the conversation can never restart.
    rmSync(first.worktree, { recursive: true, force: true })

    const again = await createTaskWorktree(repo, 'aaaabbbbcccc', 'crashed fork')

    expect(existsSync(again.worktree)).toBe(true)
    // A fork rebuild is a NEW branch off the base's current tip, not the old one.
    expect(again.branch).not.toBe(first.branch)
    expect(tryGit(['diff', '--name-only', `${again.baseline}..HEAD`], again.worktree)).toBe('')
  })

  test('work-on: the baseline is the branch tip the conversation took over', async () => {
    const { repo, featureSha } = makeRepoWithFeature()
    dirtyUp(repo)

    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'work on feature', {
      branch: 'feature',
    })

    expect(wt.baseline).toBe(featureSha)
    expect(tryGit(['diff', '--name-only', `${wt.baseline}..HEAD`], wt.worktree)).toBe('')
    // Distinct from the MR target: the commits made before the conversation
    // opened are BEHIND the anchor, not inside it.
    expect(wt.baseline).not.toBe(tryGit(['rev-parse', 'refs/heads/main'], repo))
    expect(existsSync(join(wt.worktree, 'scratch.txt'))).toBe(false)
  })
})

describe('createTaskWorktree (who created the branch)', () => {
  test('a fork always creates its branch', async () => {
    const repo = makeRepo('main')
    expect((await createTaskWorktree(repo, 'aaaabbbbcccc', 'forked')).created_branch).toBe(true)
  })

  test('work-on ADOPTS an existing local branch: not ours to delete', async () => {
    const { repo } = makeRepoWithFeature()
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'adopting', { branch: 'feature' })
    expect(wt.created_branch).toBe(false)
  })

  test('work-on on a remote-only branch CREATES the local head, and says so', async () => {
    const repo = makeRepo('main')
    execFileSync('git', ['update-ref', 'refs/remotes/origin/theirs', 'main'], { cwd: repo })
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'from origin', { branch: 'theirs' })
    expect(wt.created_branch).toBe(true)
    expect(wt.baseline).toBe(tryGit(['rev-parse', 'refs/heads/main'], repo) ?? '')
  })
})

describe('worktree operations are serialized per repository', () => {
  test('a creation WAITS for the repo lock, then both worktrees are correct', async () => {
    const repo = makeRepo('main')
    const first = await createTaskWorktree(repo, 'aaaabbbbcccc', 'first task')

    // Another holder has the repo lock when the second creation starts: it must
    // take its turn, not run beside it on the same git index.
    const other = await acquireWorktreeLock(repo)
    const order: string[] = []
    const second = await createTaskWorktree(repo, 'ddddeeeeffff', 'second task', {
      lockFn: (cwd) =>
        acquireWorktreeLock(cwd, {
          sleepFn: () => {
            order.push('waited')
            other.release()
            return Promise.resolve()
          },
        }),
    })
    order.push('acquired')

    expect(order).toEqual(['waited', 'acquired'])
    expect(second.worktree).not.toBe(first.worktree)
    expect(second.branch).not.toBe(first.branch)
    expect(tryGit(['diff', '--name-only', `${first.baseline}..HEAD`], first.worktree)).toBe('')
    expect(tryGit(['diff', '--name-only', `${second.baseline}..HEAD`], second.worktree)).toBe('')
  })

  test('an abandon waits behind the same lock, and never fails on it', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'to abandon')
    const other = await acquireWorktreeLock(repo)
    const order: string[] = []

    await removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, {
      deleteBranch: true,
      lockFn: (cwd) =>
        acquireWorktreeLock(cwd, {
          sleepFn: () => {
            order.push('waited')
            other.release()
            return Promise.resolve()
          },
        }),
    })

    expect(order).toEqual(['waited'])
    expect(existsSync(wt.worktree)).toBe(false)
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(false)
    expect(existsSync(worktreeLockPath(repo))).toBe(false)
  })

  test('a removal that cannot get its turn goes ahead — and REPORTS that it did', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'stuck repo')
    // A holder that never lets go: stranding the worktree forever would be
    // worse than removing it unserialized, but the fallback must be visible.
    const stuck = await acquireWorktreeLock(repo)
    openLocks.push(stuck)

    const removal = await removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, {
      deleteBranch: true,
      lockFn: (cwd) =>
        acquireWorktreeLock(cwd, {
          timeoutMs: 5,
          sleepFn: () => Promise.resolve(),
        }),
    })

    expect(removal.serialized).toBe(false)
    expect(removal.holder_pid).toBe(process.pid)
    expect(typeof removal.holder_age_ms).toBe('number')
    // It really did clean up, and it did not evict the holder to do so.
    expect(existsSync(wt.worktree)).toBe(false)
    expect(refExists(`refs/heads/${wt.branch}`, repo)).toBe(false)
    expect(existsSync(worktreeLockPath(repo))).toBe(true)
  })

  test('a lock failure that is NOT a spent wait is a real fault: it propagates', async () => {
    const repo = makeRepo('main')
    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'broken lock')
    const boom = new Error('lock directory is unwritable')

    await expect(
      removeTaskWorktree(repo, 'aaaabbbbcccc', wt.branch, {
        deleteBranch: true,
        lockFn: () => Promise.reject(boom),
      }),
    ).rejects.toThrow('lock directory is unwritable')
    // Nothing was silently removed on the way out.
    expect(existsSync(wt.worktree)).toBe(true)
  })

  test('a creation gives up at once when the caller is interrupted mid-wait', async () => {
    const repo = makeRepo('main')
    const stuck = await acquireWorktreeLock(repo)
    openLocks.push(stuck)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)

    // The default budget is 75 s: only the signal can end this in time.
    await expect(
      createTaskWorktree(repo, 'aaaabbbbcccc', 'interrupted', { signal: controller.signal }),
    ).rejects.toThrow(/interrupted/)
    expect(existsSync(taskWorktreePath(repo, 'aaaabbbbcccc'))).toBe(false)
  })

  test("a crashed process's lock does not block the next creation, and none is left behind", async () => {
    const repo = makeRepo('main')
    // A lock left by a process that is gone: self-healed, exactly like the
    // workspace lock. And the creation releases the one it took.
    mkdirSync(join(repo, '.codesema', 'worktrees'), { recursive: true })
    const gone = spawnSync('sh', ['-c', 'exit 0']).pid ?? 2_147_483_646
    writeFileSync(worktreeLockPath(repo), JSON.stringify({ pid: gone, at: Date.now() }))

    const wt = await createTaskWorktree(repo, 'aaaabbbbcccc', 'crash survivor')

    expect(existsSync(wt.worktree)).toBe(true)
    expect(existsSync(worktreeLockPath(repo))).toBe(false)
  })

  test('the lock never becomes part of the repository the human sees', async () => {
    const repo = makeRepo('main')
    await createTaskWorktree(repo, 'aaaabbbbcccc', 'no lock leak')
    expect(tryGit(['status', '--porcelain'], repo)).toBe('')
  })
})
