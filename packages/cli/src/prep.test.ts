import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { subprocessEnv, type ProbeExecFn } from './git.js'
import {
  computeDiffSummary,
  computePrepInput,
  detectTarget,
  prep,
  targetFromForge,
} from './prep.js'
import { AGENT_DEFS, detectAgents } from './wizard.js'

let repo: string

function run(args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    stdio: 'ignore',
    env: subprocessEnv(),
  })
}

function commitFile(name: string, content: string, msg: string) {
  writeFileSync(join(repo, name), content)
  run(['add', '-A'])
  run(['commit', '-m', msg])
}

// Fixture repo topology: main (2 commits) -> develop (1 commit) -> feature/x (1 commit).
// develop is the closest merge-base to the feature branch.
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'codesema-test-'))
  run(['init', '-b', 'main'])
  commitFile('base.txt', 'a\n', 'init: base')
  commitFile('base.txt', 'a\nb\n', 'chore: main grows')
  run(['checkout', '-b', 'develop'])
  commitFile('dev.txt', 'dev\n', 'feat: develop work')
  run(['checkout', '-b', 'feature/x'])
  commitFile('café.txt', 'contenu accentué\n', 'feat: fichier accentué')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('detectTarget', () => {
  test('valid --target resolved, source = flag', async () => {
    expect(await detectTarget('feature/x', 'develop', repo)).toEqual({
      target: 'develop',
      source: '--target flag',
    })
  })

  test('--target not found: explicit error', async () => {
    await expect(detectTarget('feature/x', 'nope', repo)).rejects.toThrow(/branch not found/)
  })

  test('heuristic: branch at the closest merge-base (develop, not main)', async () => {
    const { target, source } = await detectTarget('feature/x', undefined, repo)
    expect(target).toBe('develop')
    expect(source).toContain('heuristic')
  })
})

describe('prep', () => {
  test('complete input, non-ASCII paths intact', async () => {
    const input = await prep({ target: 'develop', cwd: repo })
    expect(input.branch).toBe('feature/x')
    expect(input.target).toBe('develop')
    expect(input.commits).toEqual(['feat: fichier accentué'])
    expect(input.files.map((f) => f.path)).toEqual(['café.txt'])
    expect(input.diff).toContain('+++ b/café.txt')
    expect(input.diff).not.toContain('\\303')
  })

  test('rules: null without RULES.md, formatted [Cn] grid lines with it', async () => {
    expect((await prep({ target: 'develop', cwd: repo, quiet: true })).rules).toBeNull()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    const rulesPath = join(repo, '.codesema', 'RULES.md')
    writeFileSync(rulesPath, '# Rules\n- no any | Where to look: exported APIs\n')
    try {
      const input = await prep({ target: 'develop', cwd: repo, quiet: true })
      expect(input.rules).toEqual(['[C1] no any | Where to look: exported APIs'])
    } finally {
      rmSync(rulesPath, { force: true })
    }
  })

  test('current branch = target: error', async () => {
    run(['checkout', 'develop'])
    try {
      await expect(prep({ target: 'develop', cwd: repo })).rejects.toThrow(/target branch itself/)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('detached HEAD: error', async () => {
    run(['checkout', '--detach'])
    try {
      await expect(prep({ target: 'develop', cwd: repo })).rejects.toThrow(/detached HEAD/)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('truncation counts code points and never splits a surrogate pair', async () => {
    run(['checkout', '-b', 'feature/emoji-subject', 'develop'])
    try {
      commitFile('emoji.txt', 'x\n', `feat: ${'🚀'.repeat(200)}`)
      const input = await prep({ target: 'develop', cwd: repo, quiet: true })
      const subject = input.commits[0] ?? ''
      expect(subject.endsWith('…')).toBe(true)
      expect(Array.from(subject)).toHaveLength(120)
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(subject)).toBe(false)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('overlong commit subjects are truncated with an ellipsis', async () => {
    run(['checkout', '-b', 'feature/long-subject', 'develop'])
    try {
      commitFile('long.txt', 'x\n', `feat: ${'y'.repeat(400)}`)
      const input = await prep({ target: 'develop', cwd: repo, quiet: true })
      expect(input.commits).toHaveLength(1)
      expect(input.commits[0]?.length).toBeLessThanOrEqual(120)
      expect(input.commits[0]?.startsWith('feat: ')).toBe(true)
      expect(input.commits[0]?.endsWith('…')).toBe(true)
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('impact_candidates: null when the diff touches no supported source file', async () => {
    const input = await prep({ target: 'develop', cwd: repo, quiet: true })
    expect(input.impact_candidates).toBeNull()
  })

  test('diff carries 10 context lines around each change', async () => {
    run(['checkout', 'develop'])
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`)
    writeFileSync(join(repo, 'context.txt'), `${lines.join('\n')}\n`)
    run(['add', '-A'])
    run(['commit', '-m', 'chore: add context file'])
    run(['checkout', '-b', 'feature/context'])
    try {
      lines[14] = 'line15 changed'
      writeFileSync(join(repo, 'context.txt'), `${lines.join('\n')}\n`)
      run(['add', '-A'])
      run(['commit', '-m', 'feat: change middle line'])
      const input = await prep({ target: 'develop', cwd: repo, quiet: true })
      expect(input.diff).toContain('line7\n')
      expect(input.diff).toContain('line23\n')
    } finally {
      run(['checkout', 'feature/x'])
    }
  })

  test('impact_candidates: filled when a changed export has callers outside the diff', async () => {
    run(['checkout', 'develop'])
    writeFileSync(
      join(repo, 'greeting.ts'),
      'export function greetUser(name: string): string {\n  return name\n}\n',
    )
    writeFileSync(
      join(repo, 'consumer.ts'),
      "import { greetUser } from './greeting'\nconsole.log(greetUser('a'))\n",
    )
    run(['add', '-A'])
    run(['commit', '-m', 'chore: add greeting and consumer'])
    run(['checkout', '-b', 'feature/impact'])
    try {
      commitFile(
        'greeting.ts',
        'export function greetUser(name: string, loud: boolean): string {\n  return name\n}\n',
        'feat: loud greeting',
      )
      const input = await prep({ target: 'develop', cwd: repo, quiet: true })
      const symbol = input.impact_candidates?.symbols.find((s) => s.name === 'greetUser')
      expect(symbol?.change).toBe('modified')
      expect(symbol?.used_at).toContain('consumer.ts:2')
      expect(input.impact_candidates?.imported_by['greeting.ts']).toContain('consumer.ts')
    } finally {
      run(['checkout', 'feature/x'])
    }
  })
})

describe('computePrepInput', () => {
  test('computes the exact same input as prep, without writing .codesema/input.json', async () => {
    rmSync(join(repo, '.codesema'), { recursive: true, force: true })
    const input = await computePrepInput({ target: 'develop', cwd: repo })
    expect(input.branch).toBe('feature/x')
    expect(input.target).toBe('develop')
    expect(input.commits).toEqual(['feat: fichier accentué'])
    expect(existsSync(join(repo, '.codesema', 'input.json'))).toBe(false)
  })

  test('prep still writes input.json by consuming computePrepInput', async () => {
    const input = await prep({ target: 'develop', cwd: repo, quiet: true })
    expect(existsSync(join(repo, '.codesema', 'input.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(repo, '.codesema', 'input.json'), 'utf8')).branch).toBe(
      input.branch,
    )
  })

  test('a baseline is carried on the input, and only the range moves with it', async () => {
    const developTip = execFileSync('git', ['rev-parse', 'develop'], { cwd: repo })
      .toString()
      .trim()
    const plain = await computePrepInput({ target: 'main', cwd: repo })
    // Absent is the honest default: an ordinary MR review pins nothing.
    expect(plain.baseline).toBeUndefined()
    expect(plain.files.map((f) => f.path)).toContain('dev.txt')

    const anchored = await computePrepInput({ target: 'main', baseline: developTip, cwd: repo })
    // The IDENTITY of the comparison is untouched: same branch, same target,
    // which is what the header shows and what keys the review archive.
    expect(anchored.branch).toBe('feature/x')
    expect(anchored.target).toBe('main')
    expect(anchored.baseline).toBe(developTip)
    // Only the SCOPE moved.
    expect(anchored.files.map((f) => f.path)).toContain('café.txt')
    expect(anchored.files.map((f) => f.path)).not.toContain('dev.txt')
  })
})

describe('computeDiffSummary', () => {
  test('pure diff computation between two refs, no target detection and no disk writes', () => {
    rmSync(join(repo, '.codesema'), { recursive: true, force: true })
    const summary = computeDiffSummary('feature/x', 'develop', repo)
    expect(summary.commits).toEqual(['feat: fichier accentué'])
    expect(summary.files.map((f) => f.path)).toEqual(['café.txt'])
    expect(summary.diff).toContain('+++ b/café.txt')
    expect(existsSync(join(repo, '.codesema'))).toBe(false)
  })

  test('throws when there is no merge base between the two refs', () => {
    expect(() => computeDiffSummary('feature/x', 'does-not-exist', repo)).toThrow(/no merge-base/)
  })

  test('a baseline narrows the SCOPE without touching the target', () => {
    // 'main' as target would measure develop's commit too; anchoring on the
    // develop tip measures only what came after it.
    const developTip = execFileSync('git', ['rev-parse', 'develop'], { cwd: repo })
      .toString()
      .trim()
    const wide = computeDiffSummary('feature/x', 'main', repo)
    expect(wide.files.map((f) => f.path)).toContain('dev.txt')
    expect(wide.commits).toContain('feat: develop work')

    const anchored = computeDiffSummary('feature/x', 'main', repo, developTip)
    expect(anchored.files.map((f) => f.path)).toContain('café.txt')
    expect(anchored.files.map((f) => f.path)).not.toContain('dev.txt')
    expect(anchored.commits).not.toContain('feat: develop work')
    expect(anchored.diff).not.toContain('dev.txt')
    // The baseline IS the base of the range it opens: no merge-base to look up.
    expect(anchored.merge_base).toBe(developTip)
  })
})

describe('boot probes', () => {
  /** Records every launch and holds the answers, so launches and answers are distinguishable. */
  function heldExec() {
    const launches: { cmd: string; args: string[] }[] = []
    const releases: ((value: string | null) => void)[] = []
    const execFn: ProbeExecFn = (cmd, args) => {
      launches.push({ cmd, args })
      return new Promise<string | null>((resolve) => releases.push(resolve))
    }
    return {
      launches,
      execFn,
      release: (values: (string | null)[]) => {
        releases.forEach((resolve, index) => resolve(values[index] ?? null))
      },
    }
  }

  test('both forge probes are launched before the first one answers', async () => {
    const rig = heldExec()
    const pending = targetFromForge(repo, rig.execFn)
    // No await yet: glab and gh are already in flight together. Chained, they
    // cost 8s + 8s; concurrent, one shared window.
    expect(rig.launches.map((l) => l.cmd)).toEqual(['glab', 'gh'])
    // Never a real forge CLI and never a shell string: the argv IS the assertion.
    expect(rig.launches[0]?.args).toEqual(['mr', 'view', '--output', 'json'])
    expect(rig.launches[1]?.args).toEqual([
      'pr',
      'view',
      '--json',
      'baseRefName',
      '--jq',
      '.baseRefName',
    ])

    rig.release([null, null])
    expect(await pending).toBeNull()
  })

  test('gitlab still wins over github when both answer', async () => {
    const rig = heldExec()
    const pending = targetFromForge(repo, rig.execFn)
    rig.release([JSON.stringify({ target_branch: 'develop' }), 'main'])
    expect(await pending).toEqual({ target: 'develop', source: 'gitlab (glab mr view)' })
  })

  test('github answers alone when glab has nothing usable', async () => {
    const rig = heldExec()
    const pending = targetFromForge(repo, rig.execFn)
    rig.release(['{ not json', 'develop'])
    expect(await pending).toEqual({ target: 'develop', source: 'github (gh pr view)' })
  })

  test('the whole boot fans out: forge and agent probes all fly before any answer', async () => {
    const rig = heldExec()
    const forge = targetFromForge(repo, rig.execFn)
    const agents = detectAgents(repo, rig.execFn)
    // Five probes (2 forges + 3 agents), zero answers so far: sequentially this
    // is where the ~40s of boot went.
    expect(rig.launches.map((l) => l.cmd)).toEqual(['glab', 'gh', ...AGENT_DEFS.map((d) => d.bin)])

    rig.release([null, null, null, null, null])
    expect(await forge).toBeNull()
    expect(await agents).toEqual([])
  })

  test('a named head ref asks the forge about THAT branch, through the list form', async () => {
    const rig = heldExec()
    const pending = targetFromForge(repo, rig.execFn, 'feature/other')
    // Never `mr view <branch>` / `pr view <branch>`: see the numeric-branch test below.
    expect(rig.launches[0]?.args).toEqual([
      'mr',
      'list',
      '--source-branch=feature/other',
      '--per-page',
      '1',
      '--output',
      'json',
    ])
    expect(rig.launches[1]?.args).toEqual([
      'pr',
      'list',
      '--head=feature/other',
      '--limit',
      '1',
      '--json',
      'baseRefName',
      '--jq',
      '.[0].baseRefName // empty',
    ])
    rig.release([null, null])
    expect(await pending).toBeNull()
  })

  test('a branch named like a number is asked about as a BRANCH, never as a PR number', async () => {
    const rig = heldExec()
    // `gh pr view 1234` / `glab mr view 1234` would read this name as pull
    // request #1234 and adopt the target of a completely unrelated MR.
    const pending = targetFromForge(repo, rig.execFn, '1234')
    for (const launch of rig.launches) {
      expect(launch.args).not.toContain('view')
      expect(launch.args).not.toContain('1234')
      expect(launch.args).toContain('list')
    }
    expect(rig.launches[0]?.args).toContain('--source-branch=1234')
    expect(rig.launches[1]?.args).toContain('--head=1234')
    rig.release([null, null])
    expect(await pending).toBeNull()
  })

  test('the list form still resolves a real branch, on either forge', async () => {
    const onGitlab = heldExec()
    const viaGlab = targetFromForge(repo, onGitlab.execFn, 'feature/other')
    // `mr list` answers an ARRAY where `mr view` answers one object.
    onGitlab.release([JSON.stringify([{ target_branch: 'develop' }]), null])
    expect(await viaGlab).toEqual({ target: 'develop', source: 'gitlab (glab mr list)' })

    const onGithub = heldExec()
    const viaGh = targetFromForge(repo, onGithub.execFn, 'feature/other')
    onGithub.release([null, 'develop'])
    expect(await viaGh).toEqual({ target: 'develop', source: 'github (gh pr list)' })
  })

  test('an empty list prints nothing, and nothing is not a branch called null', async () => {
    const rig = heldExec()
    const pending = targetFromForge(repo, rig.execFn, 'feature/other')
    rig.release(['[]', 'null'])
    expect(await pending).toBeNull()
  })

  test('a ref that could be read as a flag never reaches a forge CLI', async () => {
    const rig = heldExec()
    expect(await targetFromForge(repo, rig.execFn, '--upload-pack=evil')).toBeNull()
    expect(rig.launches).toEqual([])
  })

  test('detectTarget probes the forge with --branch other-branch, not only on HEAD', async () => {
    const rig = heldExec()
    const pending = detectTarget('feature/x', undefined, repo, {
      headRef: 'main',
      execFn: rig.execFn,
    })
    // Before the fix this argv did not exist: the guard skipped straight to
    // origin/HEAD as soon as headRef was anything but 'HEAD'.
    expect(rig.launches.map((l) => l.cmd)).toEqual(['glab', 'gh'])
    expect(rig.launches[0]?.args).toEqual([
      'mr',
      'list',
      '--source-branch=main',
      '--per-page',
      '1',
      '--output',
      'json',
    ])
    rig.release([JSON.stringify([{ target_branch: 'develop' }]), null])
    expect(await pending).toEqual({ target: 'develop', source: 'gitlab (glab mr list)' })
  })

  test('non-regression: headRef HEAD keeps its argv and its detected target', async () => {
    const rig = heldExec()
    const pending = detectTarget('feature/x', undefined, repo, { execFn: rig.execFn })
    expect(rig.launches[0]?.args).toEqual(['mr', 'view', '--output', 'json'])
    expect(rig.launches[1]?.args).toEqual([
      'pr',
      'view',
      '--json',
      'baseRefName',
      '--jq',
      '.baseRefName',
    ])
    rig.release([JSON.stringify({ target_branch: 'develop' }), null])
    expect(await pending).toEqual({ target: 'develop', source: 'gitlab (glab mr view)' })
  })

  test('the forge staying silent still falls back to the heuristic, on HEAD and on a branch', async () => {
    const silent = heldExec()
    const onHead = detectTarget('feature/x', undefined, repo, { execFn: silent.execFn })
    silent.release([null, null])
    expect(await onHead).toEqual({ target: 'develop', source: 'heuristic (nearest merge-base)' })

    const other = heldExec()
    const onBranch = detectTarget('feature/x', undefined, repo, {
      headRef: 'feature/x',
      execFn: other.execFn,
    })
    other.release([null, null])
    expect(await onBranch).toEqual({ target: 'develop', source: 'heuristic (nearest merge-base)' })
  })
})
