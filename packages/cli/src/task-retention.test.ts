import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { TaskRecord } from './contract.js'
import type { IsolationExecFn } from './task-isolation.js'
import { applyTaskRetention } from './task-retention.js'
import { createTaskWorktree, type WorktreeLockFn } from './task-worktree.js'
import { appendTaskEvent, loadTask, saveTask, taskDir, taskRecordExists } from './tasks-store.js'
import { WorktreeLockBusyError } from './worktree-lock.js'

const RUNNING_AS_ROOT = process.getuid?.() === 0

const cleanups: string[] = []

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-retention-'))
  cleanups.push(repo)
  const run = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  run(['init', '-b', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init'])
  return repo
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A terminated task with a REAL worktree + branch on disk (fork mode). */
async function seedTerminatedTask(
  repo: string,
  id: string,
  updatedAt: string,
  over: Partial<TaskRecord> = {},
): Promise<TaskRecord> {
  const wt = await createTaskWorktree(repo, id, `task ${id}`)
  const record: TaskRecord = {
    version: 1,
    id,
    title: `task ${id}`,
    status: 'shipped',
    base: wt.base,
    branch: wt.branch,
    worktree: wt.worktree,
    agent_session_id: null,
    turns: [
      { prompt: 'x', response: 'done', question: null, started_at: updatedAt, ended_at: updatedAt },
    ],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: updatedAt,
    updated_at: updatedAt,
    ...over,
  }
  saveTask(repo, record)
  return record
}

describe('applyTaskRetention', () => {
  test('keeps the N most-recently-updated terminated tasks, purges the rest', async () => {
    const repo = makeRepo()
    const oldest = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    const middle = await seedTerminatedTask(repo, 'bbbbbbbbbbbb', '2026-01-02T00:00:00.000Z')
    const newest = await seedTerminatedTask(repo, 'cccccccccccc', '2026-01-03T00:00:00.000Z')

    const outcome = await applyTaskRetention({ cwd: repo, keep: 2 })

    expect(outcome.purged).toEqual([oldest.id])
    expect(existsSync(taskDir(repo, oldest.id))).toBe(false)
    expect(existsSync(oldest.worktree)).toBe(false)
    // The two most recent survive exactly as they were.
    expect(existsSync(taskDir(repo, middle.id))).toBe(true)
    expect(existsSync(middle.worktree)).toBe(true)
    expect(existsSync(taskDir(repo, newest.id))).toBe(true)
    expect(existsSync(newest.worktree)).toBe(true)
    expect(outcome.notices.some((line) => line.includes(oldest.id))).toBe(true)
    // T1.9 review round 1, Mineur 4: the notice is a sentence a human reads,
    // never a bare internal token pasted in — DP9 vocabulary stays out of it.
    expect(outcome.notices.some((line) => line.includes('retention_worktree_purged'))).toBe(false)
    expect(
      outcome.notices.some(
        (line) => line.includes('worktree removed') && line.includes('task directory removed'),
      ),
    ).toBe(true)
  })

  // T1.9 review round 1, Critique 4: retention is unattended background
  // housekeeping — it has no way to know whether a branch carries real,
  // unpushed work worth keeping, and design.md never asked it to delete
  // branches at all. Proven directly against a branch with a real commit
  // that only this task's worktree has: it survives even keep:0, and the
  // branch this pass leaves standing is provably the SAME branch, not a
  // freshly recreated one with the same name.
  test('purging a terminated task NEVER deletes its branch, even one this pass has every reason to think it owns', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z', {
      created_branch: true, // the strongest signal the OLD deleteBranch expression would have deleted on
      work_on: false,
    })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'real work'],
      { cwd: record.worktree, stdio: 'ignore' },
    )
    const sha = execFileSync('git', ['rev-parse', record.branch], { cwd: repo }).toString().trim()

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

    expect(outcome.purged).toEqual([record.id])
    expect(existsSync(record.worktree)).toBe(false) // the worktree IS reclaimed
    const branches = execFileSync('git', ['branch', '--list', record.branch], {
      cwd: repo,
    }).toString()
    expect(branches).toContain(record.branch)
    // Not just present by name: the SAME commit, so this is provably the
    // original branch left standing, not a same-named one recreated by luck.
    expect(execFileSync('git', ['rev-parse', record.branch], { cwd: repo }).toString().trim()).toBe(
      sha,
    )
  })

  test('active and reprenable (interrupted, unfinished turn) tasks are never candidates, whatever the count', async () => {
    const repo = makeRepo()
    const running = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2020-01-01T00:00:00.000Z', {
      status: 'running',
    })
    const reprenable = await seedTerminatedTask(repo, 'bbbbbbbbbbbb', '2020-01-01T00:00:00.000Z', {
      status: 'interrupted',
      turns: [
        {
          prompt: 'x',
          response: null,
          question: null,
          started_at: '2020-01-01T00:00:00.000Z',
          ended_at: null,
        },
      ],
    })
    // Ten terminated tasks, all older-sorting than the two above by id tie-break
    // irrelevant here since updated_at differs — the point is keep:0 purges
    // EVERY terminated task while touching neither of the two above.
    const terminated: TaskRecord[] = []
    for (let i = 0; i < 3; i++) {
      terminated.push(
        await seedTerminatedTask(repo, `cccccccccc0${i}`, `2026-01-0${i + 1}T00:00:00.000Z`),
      )
    }

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

    expect(outcome.purged.toSorted()).toEqual(terminated.map((r) => r.id).toSorted())
    expect(existsSync(taskDir(repo, running.id))).toBe(true)
    expect(existsSync(running.worktree)).toBe(true)
    expect(existsSync(taskDir(repo, reprenable.id))).toBe(true)
    expect(existsSync(reprenable.worktree)).toBe(true)
    // Still genuinely resumable: the record and its unfinished turn survive.
    const stillThere = loadTask(repo, reprenable.id)
    expect(stillThere?.status).toBe('interrupted')
    expect(stillThere?.turns.at(-1)?.response).toBeNull()
  })

  test('a container-isolated purge releases the HOME volume; a release failure is named but never blocks the purge', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z', {
      isolation: 'container',
    })
    const failingExec: IsolationExecFn = (_file, args) => {
      // The runtime probe (detectContainerRuntime: `docker --version`) must
      // answer OK so the release actually reaches the volume rm below —
      // otherwise the outcome would be 'no-runtime', not the rm failure this
      // test is about.
      if (args[0] === '--version') {
        return Promise.resolve({
          code: 0,
          stdout: 'Docker version 27.0.0',
          stderr: '',
          timedOut: false,
          failure: null,
        })
      }
      return Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'volume in use',
        timedOut: false,
        failure: null,
      })
    }

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0, execFn: failingExec })

    expect(outcome.purged).toEqual([record.id])
    expect(existsSync(taskDir(repo, record.id))).toBe(false)
    expect(existsSync(record.worktree)).toBe(false)
    expect(outcome.notices[0]).toContain('NOT released')
  })

  // T1.9 review round 3, Majeur 2 (m2 in the report): retention must never
  // even ATTEMPT a release for a 'policy'-isolated task — nothing was ever
  // created for one, the same doctrine task-runner's own abandon() already
  // proves (task-runner.test.ts, 'abandon on a policy-isolated task never
  // attempts a release').
  test('a policy-isolated purge never attempts a HOME volume release: nothing was ever created', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z', {
      isolation: 'policy',
    })
    let calls = 0
    const countingExec: IsolationExecFn = () => {
      calls++
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, failure: null })
    }

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0, execFn: countingExec })

    expect(outcome.purged).toEqual([record.id])
    expect(calls).toBe(0)
    expect(outcome.notices[0]).not.toContain('HOME volume')
  })

  // DP16 (T1.6 > T1.9, DECISIONS.md): the doctrine T1.6 established — a
  // failed commit leaves real work sitting in the worktree, and the worktree
  // is where a human goes to find it — must survive retention's automatic
  // `git worktree remove --force`. Reproduced directly: an uncommitted file
  // written into the worktree, present before the pass, still present after.
  test('a dirty worktree is kept, never purged, and the notice names how many uncommitted changes it carries', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    writeFileSync(join(record.worktree, 'unsaved-work.txt'), 'the only copy\n')
    writeFileSync(join(record.worktree, 'also-unsaved.txt'), 'the only copy too\n')

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

    expect(outcome.purged).toEqual([])
    // Nothing touched: the worktree, its uncommitted file and the task
    // directory all survive exactly as they were.
    expect(existsSync(record.worktree)).toBe(true)
    expect(existsSync(join(record.worktree, 'unsaved-work.txt'))).toBe(true)
    expect(existsSync(taskDir(repo, record.id))).toBe(true)
    expect(outcome.notices).toEqual([
      `task ${record.id}: worktree kept, it carries 2 uncommitted change(s)`,
    ])
  })

  // Same doctrine, the OTHER side of "I don't know forbids the action": a
  // `git status` that cannot even be READ (not simply "the worktree is
  // gone" — existsSync handles that case separately and safely) must not be
  // read as "clean". Reproduced by making the worktree's own git admin
  // directory unreadable, a real failure rather than a simulated one.
  test.skipIf(RUNNING_AS_ROOT)(
    'a worktree whose git status cannot be determined is kept too, never purged on a guess',
    async () => {
      const repo = makeRepo()
      const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
      const adminDir = join(repo, '.git', 'worktrees', record.id)
      expect(existsSync(adminDir)).toBe(true)
      const originalMode = statSync(adminDir).mode
      chmodSync(adminDir, 0o000)
      try {
        const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

        expect(outcome.purged).toEqual([])
        expect(existsSync(record.worktree)).toBe(true)
        expect(outcome.notices[0]).toContain('could not be determined')
      } finally {
        chmodSync(adminDir, originalMode)
      }
    },
  )

  // T1.9 review round 4, CRITIQUE: the DP16 guard asks git a question whose
  // answer the USER configures. `status.showUntrackedFiles=no` is documented
  // and common on large repositories, and it makes `git status --porcelain`
  // say nothing at all about untracked files — which is EXACTLY the T1.6 case
  // this guard exists for: a commit that failed leaves work the agent never
  // got to `git add`. Read as an empty status, the guard clears `--force`,
  // the only copy of that file is destroyed, and the notice says "worktree
  // removed". Reproduced against a REAL repo carrying that real config.
  test('a worktree dirty ONLY with untracked files survives even under status.showUntrackedFiles=no', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    writeFileSync(join(record.worktree, 'only-copy.txt'), 'work no commit ever took\n')
    // Set on the worktree itself; git resolves it through the shared config
    // exactly as it would for a user who set it globally.
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: record.worktree,
      stdio: 'ignore',
    })
    // The premise, proven rather than assumed: WITHOUT the override flags,
    // this repo's `git status --porcelain` is silent about the file.
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: record.worktree,
        encoding: 'utf8',
      }).trim(),
    ).toBe('')

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

    expect(outcome.purged).toEqual([])
    expect(existsSync(join(record.worktree, 'only-copy.txt'))).toBe(true)
    expect(existsSync(taskDir(repo, record.id))).toBe(true)
    expect(outcome.notices).toEqual([
      `task ${record.id}: worktree kept, it carries 1 uncommitted change(s)`,
    ])
  })

  // The same class, the other documented config: `diff.ignoreSubmodules=all`
  // hides a submodule's uncommitted content from `git status` the same way.
  // Proven here on the simpler carrier the flag also fixes — an untracked
  // DIRECTORY, which plain porcelain folds into ONE entry regardless of how
  // many files it holds, so the count the notice reports is the number of
  // files actually at stake and not the number of directories.
  test('-uall counts untracked files one by one: the reported count is the number of files at stake', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    mkdirSync(join(record.worktree, 'notes'), { recursive: true })
    writeFileSync(join(record.worktree, 'notes', 'a.md'), 'a\n')
    writeFileSync(join(record.worktree, 'notes', 'b.md'), 'b\n')
    writeFileSync(join(record.worktree, 'notes', 'c.md'), 'c\n')
    // Plain porcelain reports the directory as a single `?? notes/` entry.
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: record.worktree, encoding: 'utf8' })
        .trim()
        .split('\n'),
    ).toHaveLength(1)

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

    expect(outcome.notices).toEqual([
      `task ${record.id}: worktree kept, it carries 3 uncommitted change(s)`,
    ])
  })

  // T1.9 review round 4, MAJEUR 2: `git worktree remove --force` CAN be
  // refused, and removeTaskWorktree used to throw its answer away. A refusal
  // followed by a record purge leaves a worktree that no record names any
  // more — a permanent orphan no future pass can find, which is the disk
  // space this pass exists to reclaim. Reproduced with `git worktree lock`,
  // the same refusal a root-owned file from a rootful containerized turn
  // produces (EACCES), without needing root to write one.
  test('a worktree git REFUSES to remove keeps its task: no purge, no orphan, retried next pass', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    execFileSync('git', ['worktree', 'lock', record.worktree], { cwd: repo, stdio: 'ignore' })
    try {
      const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

      // Nothing was reclaimed, so nothing may be claimed as reclaimed.
      expect(outcome.purged).toEqual([])
      expect(existsSync(record.worktree)).toBe(true)
      // The record is what makes the worktree findable again: it stays.
      expect(taskRecordExists(repo, record.id)).toBe(true)
      expect(existsSync(taskDir(repo, record.id))).toBe(true)
      expect(outcome.notices).toEqual([
        `task ${record.id}: its worktree could not be removed — task kept, retried on the next pass`,
      ])
      expect(outcome.notices[0]).not.toContain('worktree removed')
    } finally {
      execFileSync('git', ['worktree', 'unlock', record.worktree], { cwd: repo, stdio: 'ignore' })
    }
  })

  // T1.9 review round 4, mineur: `uncommittedCount` opened with `existsSync`,
  // the anti-pattern the round-3 critique had just removed thirty lines away
  // in `taskDirEntries` — it collapses EVERY stat error into "not there",
  // hence into a clean 0, hence into a clear road for `--force`. It was only
  // ever defended BY ACCIDENT (the worktree removal happens to fail too), and
  // an accident is not a guard. What separates the two is what the human is
  // told, which §6 bis makes the point of the exercise: "I could not find
  // out" is not "I could not remove". Reproduced by denying traversal on the
  // worktrees PARENT, so the stat itself fails with EACCES rather than ENOENT.
  test.skipIf(RUNNING_AS_ROOT)(
    'a worktree whose very path cannot be stat-ed is reported as undeterminable, never as absent',
    async () => {
      const repo = makeRepo()
      const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
      const worktreesRoot = join(repo, '.codesema', 'worktrees')
      const originalMode = statSync(worktreesRoot).mode
      chmodSync(worktreesRoot, 0o000)
      try {
        const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

        expect(outcome.purged).toEqual([])
        expect(outcome.notices).toEqual([
          `task ${record.id}: worktree kept, its git status could not be determined — left untouched`,
        ])
      } finally {
        chmodSync(worktreesRoot, originalMode)
      }
    },
  )

  test('a worktree that cannot be removed leaves the task untouched and is reported, not thrown', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    const broken: WorktreeLockFn = () => Promise.reject(new Error('EROFS: read-only file system'))

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0, worktreeLockFn: broken })

    expect(outcome.purged).toEqual([])
    expect(existsSync(taskDir(repo, record.id))).toBe(true)
    expect(existsSync(record.worktree)).toBe(true)
    expect(outcome.notices[0]).toContain('EROFS')
  })

  // DP9's premise, established on the actual code rather than assumed: a
  // purge removes the WHOLE task directory, so writing to that id's journal
  // afterward is not merely undesirable, it is IMPOSSIBLE to do honestly —
  // appendTaskEvent would silently resurrect an events.jsonl with no
  // task.json beside it, exactly what removeTaskDir's own doc comment claims.
  test('proof: a purged task cannot be journaled afterward without resurrecting its directory', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')

    await applyTaskRetention({ cwd: repo, keep: 0 })
    expect(taskRecordExists(repo, record.id)).toBe(false)
    expect(existsSync(taskDir(repo, record.id))).toBe(false)

    appendTaskEvent(repo, record.id, { type: 'error', data: { message: 'would resurrect' } })
    expect(existsSync(taskDir(repo, record.id))).toBe(true)
    expect(existsSync(join(taskDir(repo, record.id), 'events.jsonl'))).toBe(true)
    // Exactly the ghost DP9 describes: an events.jsonl with no task.json.
    expect(taskRecordExists(repo, record.id)).toBe(false)
  })

  test('an arborescence written by 0.12 (missing isolation/work_on/created_branch) is purged safely, reprenable tasks spared', async () => {
    const repo = makeRepo()
    // Raw 0.12-shaped JSON: no `isolation`, no `work_on`, no `created_branch`
    // — fields that did not exist yet. Written directly (not through
    // createTask/saveTask) to avoid smuggling in anything a 0.12 store would
    // never have had.
    const writeLegacy = (
      id: string,
      status: string,
      updatedAt: string,
      unfinished: boolean,
    ): void => {
      const dir = taskDir(repo, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'task.json'),
        JSON.stringify({
          version: 1,
          id,
          title: `legacy ${id}`,
          status,
          base: 'main',
          branch: `codesema/task-legacy-${id}`,
          worktree: join(repo, '.codesema', 'worktrees', id),
          agent_session_id: null,
          turns: [
            {
              prompt: 'x',
              response: unfinished ? null : 'done',
              question: null,
              started_at: updatedAt,
              ended_at: unfinished ? null : updatedAt,
            },
          ],
          review_ref: null,
          work_ms: 0,
          wait_ms: 0,
          auto_ship: false,
          created_at: updatedAt,
          updated_at: updatedAt,
        }),
      )
    }
    writeLegacy('aaaaaaaaaaaa', 'shipped', '2020-01-01T00:00:00.000Z', false)
    writeLegacy('bbbbbbbbbbbb', 'interrupted', '2020-01-01T00:00:00.000Z', true)

    // No worktree exists on disk for either (0.12 never wrote real ones for
    // this test) — removeTaskWorktree is best-effort by contract and must not
    // throw on one that is already gone.
    const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

    expect(outcome.purged).toEqual(['aaaaaaaaaaaa'])
    expect(taskRecordExists(repo, 'aaaaaaaaaaaa')).toBe(false)
    // The reprenable one (interrupted, unfinished turn) survives untouched.
    expect(taskRecordExists(repo, 'bbbbbbbbbbbb')).toBe(true)
    const spared = loadTask(repo, 'bbbbbbbbbbbb')
    expect(spared?.status).toBe('interrupted')
    expect(spared?.isolation).toBe('policy') // honest default for a field 0.12 never wrote
  })

  // T1.9 review round 1, Majeur 1: removeTaskDir's boolean return was
  // discarded — a directory that could NOT actually be removed (permissions,
  // a lingering open handle) was still reported as "task directory removed"
  // and its id still landed in `purged`. Proven by denying write on the
  // PARENT directory (EACCES on the entry itself is not enough — deleting an
  // entry needs write+exec on its parent, not on the entry), which makes
  // rmSync fail for a real, not simulated, reason.
  test.skipIf(RUNNING_AS_ROOT)(
    'a task directory that could NOT be removed is reported honestly, never silently claimed as purged',
    async () => {
      const repo = makeRepo()
      const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
      const tasksRoot = join(repo, '.codesema', 'tasks')
      const originalMode = statSync(tasksRoot).mode
      chmodSync(tasksRoot, 0o555)
      try {
        const outcome = await applyTaskRetention({ cwd: repo, keep: 0 })

        expect(outcome.purged).toEqual([])
        expect(existsSync(record.worktree)).toBe(false) // the worktree WAS reclaimed
        expect(existsSync(taskDir(repo, record.id))).toBe(true) // the directory was NOT
        expect(outcome.notices[0]).toContain('worktree removed')
        expect(outcome.notices[0]).toContain('could NOT be removed')
      } finally {
        chmodSync(tasksRoot, originalMode)
      }
    },
  )

  // T1.9 review round 1, Majeur 2: removeTaskWorktree's WorktreeRemoval
  // result (lock_stolen, serialized) was thrown away — the exact facts
  // task-runner's own abandon() already names on this same seam were left
  // unsaid here, on a pass that runs completely unattended.
  test('a removal that took the repo lock away from a live holder names it, on the same notice line', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    const stolenLockFn: WorktreeLockFn = () =>
      Promise.resolve({ release: () => {}, stolen: { pid: 4242, ageMs: 90_000 } })

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0, worktreeLockFn: stolenLockFn })

    expect(outcome.purged).toEqual([record.id])
    expect(outcome.notices[0]).toContain('4242')
    expect(outcome.notices[0]).toContain('stolen')
  })

  test('a removal that could not wait for the repo lock (a live holder, budget exhausted) names it too, never silently unserialized', async () => {
    const repo = makeRepo()
    const record = await seedTerminatedTask(repo, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z')
    const busyLockFn: WorktreeLockFn = () =>
      Promise.reject(
        new WorktreeLockBusyError(
          'lock busy',
          join(repo, '.codesema', 'worktree.lock'),
          777,
          12_000,
        ),
      )

    const outcome = await applyTaskRetention({ cwd: repo, keep: 0, worktreeLockFn: busyLockFn })

    expect(outcome.purged).toEqual([record.id])
    expect(outcome.notices[0]).toContain('777')
    expect(outcome.notices[0]).toContain('WITHOUT the repo lock')
  })
})
