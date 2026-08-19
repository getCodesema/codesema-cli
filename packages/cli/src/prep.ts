import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import {
  currentBranch,
  detectForgeHint,
  git,
  headSha,
  mergeBase,
  refExists,
  repoRoot,
  revListCount,
  tryExecAsync,
  tryGit,
  type ProbeExecFn,
} from './git.js'
import { t } from './i18n.js'
import { buildImpactCandidates, type ImpactCandidates } from './impact.js'
import { runProbes } from './probes.js'
import { loadRules } from './rules.js'
import type { ServerContext } from './server-context.js'
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
  files: { path: string; previousPath?: string; additions: number; deletions: number }[]
  custom_instructions: string | null
  /** Team rules from .codesema/RULES.md, one "[Cn] rule" grid line each. */
  rules: string[] | null
  impact_candidates: ImpactCandidates | null
  diff: string
  /**
   * Best-effort context fetched from the codesema server (conventions, learned
   * rules, facts, freshness); null when offline, unlinked or on any failure.
   * Always null right out of prep() (pure git computation): populated
   * separately by review() via buildServerContext(). Never a substitute for
   * `rules`, which stays local and takes precedence.
   */
  server_context: ServerContext | null
}

export function resolveRef(name: string, cwd: string): string | null {
  if (refExists(name, cwd)) {
    return name
  }
  if (refExists(`origin/${name}`, cwd)) {
    return `origin/${name}`
  }
  return null
}

function sameBranch(a: string, b: string): boolean {
  const short = (x: string) => x.replace(/^origin\//, '')
  return short(a) === short(b)
}

/** `glab mr view` answers one object, `glab mr list` an array; both carry target_branch. */
function glabTargetBranch(raw: string): string | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // unexpected glab output: no target, and the caller falls through
    return null
  }
  const first = Array.isArray(data) ? data[0] : data
  const name = (first as { target_branch?: unknown } | null | undefined)?.target_branch
  return typeof name === 'string' && name ? name : null
}

/** A `gh --jq` probe already prints the bare branch name (or nothing at all). */
function ghTargetBranch(raw: string): string | null {
  const name = raw.trim()
  return name && name !== 'null' ? name : null
}

/** The two prefixes forgeProbes builds its `source` from, and the only expensive sources. */
const FORGE_TARGET_SOURCES = ['gitlab (', 'github ('] as const

/**
 * True when a detected target came from a forge probe rather than from
 * `origin/HEAD`, the merge-base heuristic or the `--target` flag. Lives here,
 * next to the strings it recognises, so no caller has to re-spell them.
 */
export function isForgeTargetSource(source: string): boolean {
  return FORGE_TARGET_SOURCES.some((prefix) => source.startsWith(prefix))
}

type ForgeProbe = {
  label: string
  /** How the answer is read back — the two forges do not print the same thing. */
  read: (raw: string) => string | null
  /** What goes in `target_source`: the command actually run, not a family name. */
  source: string
  run: () => Promise<string | null>
}

/**
 * How each porcelain is asked about `headRef`, gitlab first (the preference is
 * unchanged), skipping the CLI that origin clearly rules out.
 *
 * A NAMED branch is never passed as a positional. `gh pr view 1234` and
 * `glab mr view 1234` read a purely numeric argument as a PR/MR **number**, so
 * a branch called `1234` would adopt the target of an unrelated pull request —
 * and no guard on the name alone is enough, since the porcelains resolve other
 * shapes (a URL, an id) the same way. The named case therefore asks the
 * unambiguous LIST form instead, where the branch can only be read as a
 * branch: `gh pr list --head=<branch>` (`-H`, gh 2.46.0) and
 * `glab mr list --source-branch=<branch>` (`-s`, glab 1.53.0), both with the
 * value attached so it cannot be re-read as an option either.
 *
 * Both list forms answer OPEN requests only (their shared default), which is
 * the question being asked here — what does this branch target *now*; a branch
 * whose request is already closed falls through to origin/HEAD like any other
 * unanswered probe.
 *
 * 'HEAD' means "the checked-out one", which is exactly what both porcelains
 * answer when given no positional argument, so that case keeps its historical
 * argv byte for byte.
 */
function forgeProbes(cwd: string, headRef: string, execFn: ProbeExecFn): ForgeProbe[] {
  const named = headRef !== 'HEAD'
  // Each probe blocks up to 8s; when origin clearly names one forge, skip the other.
  // An unrecognized remote (self-hosted on a custom domain) still probes both.
  const hint = detectForgeHint(cwd)
  const probes: ForgeProbe[] = []
  if (hint !== 'github') {
    const args = named
      ? ['mr', 'list', `--source-branch=${headRef}`, '--per-page', '1', '--output', 'json']
      : ['mr', 'view', '--output', 'json']
    probes.push({
      label: 'glab',
      read: glabTargetBranch,
      source: `gitlab (glab mr ${named ? 'list' : 'view'})`,
      run: () => execFn('glab', args, cwd),
    })
  }
  if (hint !== 'gitlab') {
    const args = named
      ? [
          'pr',
          'list',
          `--head=${headRef}`,
          '--limit',
          '1',
          '--json',
          'baseRefName',
          // `// empty` so an empty result prints nothing instead of the string "null".
          '--jq',
          '.[0].baseRefName // empty',
        ]
      : ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName']
    probes.push({
      label: 'gh',
      read: ghTargetBranch,
      source: `github (gh pr ${named ? 'list' : 'view'})`,
      run: () => execFn('gh', args, cwd),
    })
  }
  return probes
}

/**
 * Target branch as the forge CLIs see it. Both probes are launched before the
 * first one answers, so the pair costs one shared 8s window instead of 16s
 * chained; the per-probe timeout is untouched and gitlab still wins over github
 * when both answer (they are read back in launch order).
 *
 * `headRef` names the branch to ask about; see forgeProbes for how each forge
 * is asked, and why a named branch never travels as a positional.
 */
export async function targetFromForge(
  cwd: string,
  execFn: ProbeExecFn = tryExecAsync,
  headRef = 'HEAD',
): Promise<{ target: string; source: string } | null> {
  // Belt and braces: git cannot create a branch whose name starts with '-',
  // so this is unreachable through prep/preview — but a ref that could be
  // read as a flag never reaches a forge CLI. Skipping the probe is the safe
  // half of the choice: the caller falls back to origin/HEAD.
  if (headRef !== 'HEAD' && headRef.startsWith('-')) {
    return null
  }
  const probes = forgeProbes(cwd, headRef, execFn)
  const outcomes = await runProbes(probes)
  for (const [index, probe] of probes.entries()) {
    const raw = outcomes[index]
    const name = raw ? probe.read(raw) : null
    const ref = name ? resolveRef(name, cwd) : null
    if (ref) {
      return { target: ref, source: probe.source }
    }
  }
  return null
}

/** Repo default branch as a remote-tracking ref; also the base a new task branches from. */
export function targetFromOriginHead(cwd: string): { target: string; source: string } | null {
  const sym = tryGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd)
  if (!sym) {
    return null
  }
  const ref = sym.replace('refs/remotes/', '')
  if (!refExists(ref, cwd)) {
    return null
  }
  return { target: ref, source: 'origin/HEAD' }
}

function targetFromHeuristic(
  current: string,
  headRef: string,
  cwd: string,
): { target: string; source: string } | null {
  let best: { target: string; distance: number } | null = null
  for (const name of TARGET_CANDIDATES) {
    const ref = resolveRef(name, cwd)
    if (!ref || sameBranch(ref, current)) {
      continue
    }
    const mb = mergeBase(ref, headRef, cwd)
    if (!mb) {
      continue
    }
    const distance = revListCount(`${mb}..${headRef}`, cwd)
    if (distance === null) {
      continue
    }
    if (!best || distance < best.distance) {
      best = { target: ref, distance }
    }
  }
  return best ? { target: best.target, source: 'heuristic (nearest merge-base)' } : null
}

export type DetectTargetOptions = {
  /** Ref whose target is being detected; 'HEAD' means the checked-out branch. */
  headRef?: string | undefined
  /** Test seam: no test runs a real gh/glab, it asserts on the argv it was handed. */
  execFn?: ProbeExecFn | undefined
}

/**
 * Options object rather than two more positional parameters: the repo caps a
 * signature at four (oxlint max-params), and the existing three-argument call
 * sites stay untouched.
 */
export async function detectTarget(
  current: string,
  flag: string | undefined,
  cwd: string,
  opts: DetectTargetOptions = {},
): Promise<{ target: string; source: string }> {
  const headRef = opts.headRef ?? 'HEAD'
  if (flag) {
    const ref = resolveRef(flag, cwd)
    if (!ref) {
      throw new Error(t('prep.targetFlagNotFound', { flag }))
    }
    return { target: ref, source: '--target flag' }
  }
  // The forge is probed whatever the head ref is. It used to be skipped unless
  // headRef was 'HEAD', so `--branch other-branch` jumped straight to
  // origin/HEAD — incoherent the moment the forge is the source of truth (D7).
  const forge = await targetFromForge(cwd, opts.execFn ?? tryExecAsync, headRef)
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
      if (!line || line.startsWith('#')) {
        continue
      }
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
  return git(
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '-U10', range, '--', '.', ...excludes],
    cwd,
  )
}

/** Truncates by code points: a UTF-16 slice can split a surrogate pair. */
function truncateSubject(subject: string): string {
  const codePoints = Array.from(subject)
  return codePoints.length > COMMIT_SUBJECT_MAX
    ? `${codePoints.slice(0, COMMIT_SUBJECT_MAX - 1).join('')}…`
    : subject
}

export type DiffSummary = {
  merge_base: string
  commits: string[]
  files: { path: string; previousPath?: string; additions: number; deletions: number }[]
  diff: string
}

function parseNumstat(raw: string): DiffSummary['files'] {
  const records = raw.split('\0')
  const files: DiffSummary['files'] = []
  for (let i = 0; i < records.length - 1; i += 1) {
    const [add = '0', del = '0', ...rest] = (records[i] ?? '').split('\t')
    let path = rest.join('\t')
    let previousPath: string | undefined
    if (!path) {
      // Rename/copy record: `add\tdel\t` followed by two NUL-separated paths (source, destination).
      previousPath = records[i + 1]
      i += 2
      path = records[i] ?? ''
    }
    if (path) {
      files.push({
        path,
        ...(previousPath ? { previousPath } : {}),
        additions: Number.isFinite(Number(add)) ? Number(add) : 0,
        deletions: Number.isFinite(Number(del)) ? Number(del) : 0,
      })
    }
  }
  return files
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

  const commits = (
    tryGit(['log', '--pretty=%s', `${targetRef}..${sourceRef}`, '--max-count=30'], cwd) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .map(truncateSubject)

  const files = parseNumstat(
    tryGit(
      ['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', range, '--', '.', ...excludes],
      cwd,
    ) ?? '',
  )

  return { merge_base: mb, commits, files, diff }
}

/** Pure calculation behind `prep`: no disk writes, safe to call for a preview. */
export async function computePrepInput(opts: {
  branch?: string | undefined
  target?: string | undefined
  cwd: string
}): Promise<PrepInput> {
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

  const { target, source } = await detectTarget(branch, opts.target, cwd, { headRef })
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
    server_context: null,
  }
}

export async function prep(opts: {
  branch?: string | undefined
  target?: string | undefined
  cwd: string
  quiet?: boolean | undefined
}): Promise<PrepInput> {
  const input = await computePrepInput(opts)
  const {
    branch,
    target,
    target_source: source,
    files,
    commits,
    custom_instructions: custom,
    rules,
    repo_root: cwd,
  } = input

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
      ...(rules
        ? [{ label: t('prep.label.rules'), value: t('prep.rulesNote', { n: rules.length }) }]
        : []),
      { label: t('prep.label.input'), value: inputPath },
    ]
    for (const line of renderFieldRows(rows)) {
      console.log(line)
    }
    console.log('')
    console.log(t('prep.next'))
  }
  return input
}
