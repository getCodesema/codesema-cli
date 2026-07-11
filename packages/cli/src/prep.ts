// `codesema prep` : détecte la branche courante et la branche cible, calcule le
// diff de la MR, et écrit .codesema/input.json pour l'agent IA.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import { currentBranch, git, headSha, mergeBase, refExists, repoRoot, revListCount, tryExec, tryGit } from './git.js'

const TARGET_CANDIDATES = ['develop', 'main', 'master'] as const

const DEFAULT_EXCLUDES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  '*.min.js',
  '*.min.css',
  '*.map',
]

export type PrepInput = {
  version: 1
  generated_by: string
  title: string
  branch: string
  target: string
  target_source: string
  merge_base: string
  head_sha: string
  repo_root: string
  commits: string[]
  files: { path: string; additions: number; deletions: number }[]
  custom_instructions: string | null
  diff: string
}

/** Résout un nom de branche court vers une ref locale ou origin/<nom>. */
function resolveRef(name: string, cwd: string): string | null {
  if (refExists(name, cwd)) return name
  if (refExists(`origin/${name}`, cwd)) return `origin/${name}`
  return null
}

function sameBranch(a: string, b: string): boolean {
  const short = (x: string) => x.replace(/^origin\//, '')
  return short(a) === short(b)
}

function targetFromForge(cwd: string): { target: string; source: string } | null {
  const glabOut = tryExec('glab', ['mr', 'view', '--output', 'json'], cwd)
  if (glabOut) {
    try {
      const name = (JSON.parse(glabOut) as { target_branch?: string }).target_branch
      if (name) {
        const ref = resolveRef(name, cwd)
        if (ref) return { target: ref, source: 'gitlab (glab mr view)' }
      }
    } catch {
      // sortie glab inattendue : on passe au fallback suivant
    }
  }
  const ghOut = tryExec('gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'], cwd)
  if (ghOut) {
    const ref = resolveRef(ghOut, cwd)
    if (ref) return { target: ref, source: 'github (gh pr view)' }
  }
  return null
}

function targetFromOriginHead(cwd: string): { target: string; source: string } | null {
  const sym = tryGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  if (!sym) return null
  const ref = sym.replace('refs/remotes/', '')
  if (!refExists(ref, cwd)) return null
  return { target: ref, source: 'origin/HEAD' }
}

function targetFromHeuristic(current: string, headRef: string, cwd: string): { target: string; source: string } | null {
  let best: { target: string; distance: number } | null = null
  for (const name of TARGET_CANDIDATES) {
    const ref = resolveRef(name, cwd)
    if (!ref || sameBranch(ref, current)) continue
    const mb = mergeBase(ref, headRef, cwd)
    if (!mb) continue
    const distance = revListCount(`${mb}..${headRef}`, cwd)
    if (distance === null) continue
    if (!best || distance < best.distance) best = { target: ref, distance }
  }
  return best ? { target: best.target, source: 'heuristic (nearest merge-base)' } : null
}

export function detectTarget(
  current: string,
  flag: string | undefined,
  cwd: string,
  headRef = 'HEAD',
): { target: string; source: string } {
  if (flag) {
    const ref = resolveRef(flag, cwd)
    if (!ref) throw new Error(`--target ${flag}: branch not found (neither local nor origin/${flag})`)
    return { target: ref, source: '--target flag' }
  }
  const forge = headRef === 'HEAD' ? targetFromForge(cwd) : null
  const detected = forge ?? targetFromOriginHead(cwd) ?? targetFromHeuristic(current, headRef, cwd)
  if (!detected) {
    throw new Error('could not detect the target branch — pass it explicitly with --target <branch>')
  }
  return detected
}

function excludePathspecs(cwd: string): string[] {
  const patterns = [...DEFAULT_EXCLUDES]
  const ignoreFile = join(cwd, '.codesema-ignore')
  if (existsSync(ignoreFile)) {
    for (const raw of readFileSync(ignoreFile, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      patterns.push(line)
    }
  }
  return patterns.map((p) => (p.includes('/') ? `:(exclude,glob)${p}` : `:(exclude,glob)**/${p}`))
}

/** Diff MR sur un range, mêmes exclusions que prep (lockfiles, .codesema-ignore).
 *  quotePath=false : sans lui, git échappe les chemins non-ASCII ("caf\303\251.txt")
 *  et le matching finding↔fichier casse dans l'UI. */
export function mrDiff(range: string, cwd: string): string {
  const excludes = excludePathspecs(cwd)
  return git(['-c', 'core.quotePath=false', 'diff', '--no-color', range, '--', '.', ...excludes], cwd)
}

export function prep(opts: { branch?: string; target?: string; cwd: string; quiet?: boolean }): PrepInput {
  const cwd = repoRoot(opts.cwd)
  const checkedOut = currentBranch(cwd)
  const branch = opts.branch ?? checkedOut
  if (branch === 'HEAD') {
    throw new Error('detached HEAD — checkout the branch you want reviewed first, or pass --branch <name>')
  }
  if (opts.branch && !refExists(`refs/heads/${opts.branch}`, cwd)) {
    throw new Error(`--branch ${opts.branch}: local branch not found`)
  }
  const headRef = opts.branch && opts.branch !== checkedOut ? opts.branch : 'HEAD'

  const { target, source } = detectTarget(branch, opts.target, cwd, headRef)
  if (sameBranch(target, branch)) {
    throw new Error(
      `"${branch}" is the target branch itself — pick your feature branch, or pass --target <branch>`,
    )
  }

  const mb = mergeBase(target, headRef, cwd)
  if (!mb) {
    throw new Error(`no merge-base between ${target} and ${branch} — pass another base with --target <branch>`)
  }

  const excludes = excludePathspecs(cwd)
  const range = `${target}...${headRef}`
  const diff = mrDiff(range, cwd)
  if (!diff.trim()) {
    const dirty = headRef === 'HEAD' ? tryGit(['status', '--porcelain'], cwd) : null
    const hint = dirty?.trim()
      ? ' Your working tree has uncommitted changes: commit them first, codesema reviews committed work.'
      : ''
    throw new Error(`empty diff between ${target} and ${branch} — nothing to review.${hint}`)
  }

  const commits = (tryGit(['log', '--pretty=%s', `${target}..${headRef}`, '--max-count=30'], cwd) ?? '')
    .split('\n')
    .filter(Boolean)

  const files = (tryGit(['-c', 'core.quotePath=false', 'diff', '--numstat', range, '--', '.', ...excludes], cwd) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [add = '0', del = '0', ...rest] = line.split('\t')
      return {
        path: rest.join('\t'),
        additions: Number.isFinite(Number(add)) ? Number(add) : 0,
        deletions: Number.isFinite(Number(del)) ? Number(del) : 0,
      }
    })

  const promptFile = join(cwd, '.codesema', 'PROMPT.md')
  const custom = existsSync(promptFile) ? readFileSync(promptFile, 'utf8').trim() || null : null

  const input: PrepInput = {
    version: 1,
    generated_by: 'codesema prep',
    title: branch,
    branch,
    target,
    target_source: source,
    merge_base: mb,
    head_sha: headSha(cwd, headRef),
    repo_root: cwd,
    commits,
    files,
    custom_instructions: custom,
    diff,
  }

  const dir = ensureWorkDir(cwd)
  const inputPath = join(dir, 'input.json')
  writeFileSync(inputPath, JSON.stringify(input, null, 2))

  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  if (!opts.quiet) {
    console.log('codesema prep')
    console.log(`  branch : ${branch}`)
    console.log(`  target : ${target} (${source})`)
    console.log(`  files  : ${files.length} (+${additions} −${deletions})`)
    console.log(`  commits: ${commits.length}`)
    if (custom) console.log('  custom : .codesema/PROMPT.md merged into instructions')
    console.log(`  input  : ${inputPath}`)
    console.log('')
    console.log('Next: have your AI agent write .codesema/review.json (see the codesema skill), then run `codesema show`.')
  }
  return input
}
