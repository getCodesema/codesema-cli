import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import { currentBranch, detectForgeHint, git, headSha, mergeBase, refExists, repoRoot, revListCount, tryExec, tryGit } from './git.js'
import { buildImpactCandidates, type ImpactCandidates } from './impact.js'
import { t } from './i18n.js'
import { loadRules } from './rules.js'
import { renderFieldRows, type FieldRow } from './ui.js'

const TARGET_CANDIDATES = ['develop', 'main', 'master'] as const

const COMMIT_SUBJECT_MAX = 120

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
  /** Team rules from .codesema/RULES.md, one "[Cn] rule" grid line each. */
  rules: string[] | null
  impact_candidates: ImpactCandidates | null
  diff: string
}

export function resolveRef(name: string, cwd: string): string | null {
  if (refExists(name, cwd)) return name
  if (refExists(`origin/${name}`, cwd)) return `origin/${name}`
  return null
}

function sameBranch(a: string, b: string): boolean {
  const short = (x: string) => x.replace(/^origin\//, '')
  return short(a) === short(b)
}

function targetFromForge(cwd: string): { target: string; source: string } | null {
  // Each probe blocks up to 8s; when origin clearly names one forge, skip the other.
  // An unrecognized remote (self-hosted on a custom domain) still probes both.
  const hint = detectForgeHint(cwd)
  const skipGitlab = hint === 'github'
  const skipGithub = hint === 'gitlab'

  const glabOut = skipGitlab ? null : tryExec('glab', ['mr', 'view', '--output', 'json'], cwd)
  if (glabOut) {
    try {
      const name = (JSON.parse(glabOut) as { target_branch?: string }).target_branch
      if (name) {
        const ref = resolveRef(name, cwd)
        if (ref) return { target: ref, source: 'gitlab (glab mr view)' }
      }
    } catch {
      // unexpected glab output: fall through to the next fallback
    }
  }
  const ghOut = skipGithub ? null : tryExec('gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'], cwd)
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
    if (!ref) throw new Error(t('prep.targetFlagNotFound', { flag }))
    return { target: ref, source: '--target flag' }
  }
  const forge = headRef === 'HEAD' ? targetFromForge(cwd) : null
  const detected = forge ?? targetFromOriginHead(cwd) ?? targetFromHeuristic(current, headRef, cwd)
  if (!detected) {
    throw new Error(t('prep.noTarget'))
  }
  return detected
}

export function excludePathspecs(cwd: string): string[] {
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

/**
 * MR diff over a range, same exclusions as prep (lockfiles, .codesema-ignore).
 * quotePath=false: without it, git escapes non-ASCII filenames as octal
 * sequences (e.g. "caf\303\251.txt"), and finding-to-file matching breaks in the UI.
 * -U10: reviewers judge changes against the enclosing code, not three bare lines.
 */
export function mrDiff(range: string, cwd: string, excludes = excludePathspecs(cwd)): string {
  return git(['-c', 'core.quotePath=false', 'diff', '--no-color', '-U10', range, '--', '.', ...excludes], cwd)
}

/** Truncates by code points: a UTF-16 slice can split a surrogate pair. */
function truncateSubject(subject: string): string {
  const codePoints = Array.from(subject)
  return codePoints.length > COMMIT_SUBJECT_MAX ? `${codePoints.slice(0, COMMIT_SUBJECT_MAX - 1).join('')}…` : subject
}

export type DiffSummary = {
  merge_base: string
  commits: string[]
  files: { path: string; additions: number; deletions: number }[]
  diff: string
}

/**
 * Pure git computation between two refs (no target detection, no disk writes):
 * shared by computePrepInput (local branch vs. detected target) and the web
 * preview endpoints (arbitrary local or remote-tracking refs, e.g. an MR not
 * checked out locally).
 */
export function computeDiffSummary(sourceRef: string, targetRef: string, cwd: string): DiffSummary {
  const mb = mergeBase(targetRef, sourceRef, cwd)
  if (!mb) {
    throw new Error(t('prep.noMergeBase', { target: targetRef, branch: sourceRef }))
  }

  const excludes = excludePathspecs(cwd)
  const range = `${targetRef}...${sourceRef}`
  const diff = mrDiff(range, cwd, excludes)

  const commits = (tryGit(['log', '--pretty=%s', `${targetRef}..${sourceRef}`, '--max-count=30'], cwd) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(truncateSubject)

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

  return { merge_base: mb, commits, files, diff }
}

/** Pure calculation behind `prep`: no disk writes, safe to call for a preview. */
export function computePrepInput(opts: { branch?: string; target?: string; cwd: string }): PrepInput {
  const cwd = repoRoot(opts.cwd)
  const checkedOut = currentBranch(cwd)
  const branch = opts.branch ?? checkedOut
  if (branch === 'HEAD') {
    throw new Error(t('prep.detachedHead'))
  }
  if (opts.branch && !refExists(`refs/heads/${opts.branch}`, cwd)) {
    throw new Error(t('prep.branchNotFound', { branch: opts.branch }))
  }
  const headRef = opts.branch && opts.branch !== checkedOut ? opts.branch : 'HEAD'

  const { target, source } = detectTarget(branch, opts.target, cwd, headRef)
  if (sameBranch(target, branch)) {
    throw new Error(t('prep.targetIsSelf', { branch }))
  }

  const { merge_base: mb, commits, files, diff } = computeDiffSummary(headRef, target, cwd)
  if (!diff.trim()) {
    const dirty = headRef === 'HEAD' ? tryGit(['status', '--porcelain'], cwd) : null
    const hint = dirty?.trim() ? t('prep.dirtyHint') : ''
    throw new Error(t('prep.emptyDiff', { target, branch, hint }))
  }

  const promptFile = join(cwd, '.codesema', 'PROMPT.md')
  const custom = existsSync(promptFile) ? readFileSync(promptFile, 'utf8').trim() || null : null
  const rules = loadRules(cwd)

  return {
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
    rules,
    impact_candidates: buildImpactCandidates(diff, cwd),
    diff,
  }
}

export function prep(opts: { branch?: string; target?: string; cwd: string; quiet?: boolean }): PrepInput {
  const input = computePrepInput(opts)
  const { branch, target, target_source: source, files, commits, custom_instructions: custom, rules, repo_root: cwd } = input

  const dir = ensureWorkDir(cwd)
  const inputPath = join(dir, 'input.json')
  writeFileSync(inputPath, JSON.stringify(input, null, 2))

  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  if (!opts.quiet) {
    console.log(t('prep.title'))
    console.log('')
    const rows: FieldRow[] = [
      { label: t('prep.label.branch'), value: branch },
      { label: t('prep.label.target'), value: `${target} (${source})` },
      { label: t('prep.label.files'), value: `${files.length} (+${additions} −${deletions})` },
      { label: t('prep.label.commits'), value: String(commits.length) },
      ...(custom ? [{ label: t('prep.label.custom'), value: t('prep.customNote') }] : []),
      ...(rules ? [{ label: t('prep.label.rules'), value: t('prep.rulesNote', { n: rules.length }) }] : []),
      { label: t('prep.label.input'), value: inputPath },
    ]
    for (const line of renderFieldRows(rows)) console.log(line)
    console.log('')
    console.log(t('prep.next'))
  }
  return input
}
