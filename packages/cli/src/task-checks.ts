// Checks engine: codesema (never the agent) verifies a task's worktree by
// running typecheck/tests/lint inside an EPHEMERAL container mounted on it.
// The agent gains no execution rights — the runner commits, then this engine
// runs the repo's checks in a cage: worktree mounted rw, the repo's git
// directory read-only (a linked worktree's `.git` points outside the mount —
// container-git.ts), nothing else, no network for check commands, cpu/memory
// capped, one timeout per check.
// Everything host-side goes through execFile with an argv array: no shell
// interpolation ever happens on the host (the check command itself runs under
// `sh -lc` INSIDE the container, where it can do no harm beyond the mount).
// Package cache lives in a per-project named volume. node_modules still land
// in the worktree — the runner commits from the host.

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gitSafeDirectoryEnvArgs, prepareContainerGit } from './container-git.js'
import {
  TASK_CHECK_TAIL_MAX,
  type TaskCheckResult,
  type TaskChecks,
  type TaskChecksSource,
} from './contract.js'
import type { ChecksConfig } from './repo-config.js'

/** Per-check wall-clock budget when the repo config does not set one. */
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 300
/** Image used when an explicit config sets commands but no image. */
export const DEFAULT_CHECKS_IMAGE = 'node:26'

/**
 * Bun's default installer hardlinks from its cache into node_modules. The
 * cache is a named volume and the worktree is a bind mount — two filesystems
 * — so hardlink fails with ENOENT. copyfile is slower and works.
 */
export const BUN_INSTALL_COMMAND = 'bun install --frozen-lockfile --backend=copyfile'

/** Combined stdout+stderr capture cap per exec (the persisted tail is far smaller). */
const EXEC_MAX_BUFFER = 10 * 1024 * 1024

/** Worktree mount point inside a checks container; the step's cwd. */
const CHECKS_WORK_DIR = '/work'

export type ExecResult = {
  /** Exit code; null when the process never exited on its own (timeout, spawn failure). */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Spawn-level failure message (binary missing, EACCES...), null otherwise. */
  failure: string | null
}

/** Host-side process runner, injectable in tests (unit tests NEVER run docker). */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>

/**
 * Real exec: execFile only (argv array, no shell), host env inherited — the
 * docker/podman CLIENT needs it (DOCKER_HOST, XDG_RUNTIME_DIR for rootless
 * podman); the CONTAINER still starts from the image's own minimal env
 * because no -e flag ever forwards host variables. Never rejects: every
 * failure mode is folded into the ExecResult.
 */
const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: EXEC_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, timedOut: false, failure: null })
          return
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
        if (e.killed || e.signal) {
          // execFile kills with killSignal on timeout (and on maxBuffer
          // overflow — close enough to a runaway check to report the same).
          resolve({ code: null, stdout, stderr, timedOut: true, failure: null })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, stdout, stderr, timedOut: false, failure: null })
          return
        }
        // String code (ENOENT...) = the process never ran.
        resolve({ code: null, stdout, stderr, timedOut: false, failure: e.message })
      },
    )
  })

/** 'docker' first (the common case, and podman ships a docker shim), then 'podman'. */
export async function detectContainerRuntime(execFn: ExecFn): Promise<string | null> {
  for (const bin of ['docker', 'podman']) {
    const probe = await execFn(bin, ['--version'], { timeoutMs: 10_000 })
    if (probe.code === 0) {
      return bin
    }
  }
  return null
}

let cachedRuntime: Promise<string | null> | null = null

/** Detection runs ONCE per process for the real exec; injected execFns (tests) always re-probe. */
function containerRuntime(execFn?: ExecFn): Promise<string | null> {
  if (execFn) {
    return detectContainerRuntime(execFn)
  }
  cachedRuntime ??= detectContainerRuntime(defaultExec)
  return cachedRuntime
}

/** What one checks run will do; null = nothing detected/configured ('unconfigured'). */
export type ChecksPlan = {
  image: string
  /** Dependency install step, run first; the only step that may get network. */
  install: string | null
  commands: string[]
  /** True: the INSTALL step runs with network; check commands NEVER do. */
  network: boolean
  timeoutSeconds: number
  /** Which precedence level produced the COMMANDS; stamped on checks.json. */
  source: TaskChecksSource
}

export type DetectChecksInput = {
  /** Top-level entry names of the worktree (plain readdir). */
  files: string[]
  /** Parsed package.json when present. */
  packageJson?: { scripts?: Record<string, unknown> } | null
  /** Raw pyproject.toml content when present. */
  pyproject?: string | null
}

const CHECK_SCRIPT_NAMES = ['typecheck', 'test', 'lint'] as const

function scriptNames(packageJson: DetectChecksInput['packageJson']): Set<string> {
  const scripts = packageJson?.scripts
  if (!scripts || typeof scripts !== 'object') {
    return new Set()
  }
  return new Set(Object.keys(scripts))
}

/**
 * PURE stack detection from a worktree listing. Detected plans grant the
 * install step network access (a registry-less install cannot succeed on a
 * fresh worktree); explicit config keeps its own network flag. Precedence:
 * bun, then npm/yarn lockfiles, then pyproject — first match wins.
 */
export function detectChecks(input: DetectChecksInput): ChecksPlan | null {
  const files = new Set(input.files)
  const scripts = scriptNames(input.packageJson)
  // 'scripts': the lockfile/package.json heuristic is the lowest precedence
  // level; a declaration or a config overrides the commands (and the label).
  const base = {
    network: true,
    timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    source: 'scripts' as const,
  }
  if (files.has('bun.lock') || files.has('bun.lockb')) {
    const commands: string[] = []
    if (scripts.has('typecheck')) {
      commands.push('bun run typecheck')
    }
    // bun has a built-in test runner: a missing test script is not "no tests".
    commands.push(scripts.has('test') ? 'bun run test' : 'bun test')
    if (scripts.has('lint')) {
      commands.push('bun run lint')
    }
    return { image: 'oven/bun:1', install: BUN_INSTALL_COMMAND, commands, ...base }
  }
  if (files.has('package-lock.json') || files.has('yarn.lock')) {
    const commands = CHECK_SCRIPT_NAMES.filter((name) => scripts.has(name)).map(
      (name) => `npm run ${name}`,
    )
    // npm has no runnable default: no scripts among the three = nothing to check.
    if (commands.length === 0) {
      return null
    }
    return { image: DEFAULT_CHECKS_IMAGE, install: 'npm ci', commands, ...base }
  }
  if (files.has('pyproject.toml')) {
    // Only when the project itself declares pytest; guessing a test runner
    // for an arbitrary python project would fail more than it helps.
    if (!/\bpytest\b/.test(input.pyproject ?? '')) {
      return null
    }
    return { image: 'python:3.12', install: 'pip install -e .', commands: ['pytest'], ...base }
  }
  return null
}

/** Image + install command for a worktree, even when there is nothing to CHECK. */
export type InstallPlan = {
  image: string
  install: string
  timeoutSeconds: number
}

/**
 * Lockfile / manifest → how to install, ignoring whether any check script
 * exists. An npm repo with only a `build` script has nothing for `detectChecks`
 * and still has an install step — that is the hole #63 closes.
 */
export function detectInstall(input: DetectChecksInput): InstallPlan | null {
  const files = new Set(input.files)
  const timeoutSeconds = DEFAULT_CHECK_TIMEOUT_SECONDS
  if (files.has('bun.lock') || files.has('bun.lockb')) {
    return { image: 'oven/bun:1', install: BUN_INSTALL_COMMAND, timeoutSeconds }
  }
  if (files.has('package-lock.json') || files.has('yarn.lock')) {
    return { image: DEFAULT_CHECKS_IMAGE, install: 'npm ci', timeoutSeconds }
  }
  if (files.has('package.json')) {
    return { image: DEFAULT_CHECKS_IMAGE, install: 'npm install', timeoutSeconds }
  }
  if (files.has('pyproject.toml')) {
    return { image: 'python:3.12', install: 'pip install -e .', timeoutSeconds }
  }
  return null
}

/** Disk-reading wrapper; any read failure = nothing to install. */
export function detectInstallFromWorktree(worktree: string): InstallPlan | null {
  let files: string[]
  try {
    files = readdirSync(worktree)
  } catch {
    return null
  }
  const readIfPresent = (name: string): string | null => {
    if (!files.includes(name)) {
      return null
    }
    try {
      return readFileSync(join(worktree, name), 'utf8')
    } catch {
      return null
    }
  }
  let packageJson: { scripts?: Record<string, unknown> } | null = null
  const rawPackageJson = readIfPresent('package.json')
  if (rawPackageJson) {
    try {
      packageJson = JSON.parse(rawPackageJson) as { scripts?: Record<string, unknown> } | null
    } catch {
      packageJson = null
    }
  }
  return detectInstall({ files, packageJson, pyproject: readIfPresent('pyproject.toml') })
}

/**
 * Install step to run before an agent turn: explicit checks config.install
 * wins, otherwise the lockfile heuristic (including npm repos with no check
 * scripts). Null = this worktree has nothing to install.
 */
export function resolveInstallPlan(input: {
  worktree: string
  config?: ChecksConfig | null
}): InstallPlan | null {
  const configured = input.config?.install?.trim()
  if (configured) {
    return {
      image: input.config?.image?.trim() || DEFAULT_CHECKS_IMAGE,
      install: configured,
      timeoutSeconds:
        Number.isInteger(input.config?.timeoutSeconds) &&
        (input.config?.timeoutSeconds as number) > 0
          ? (input.config?.timeoutSeconds as number)
          : DEFAULT_CHECK_TIMEOUT_SECONDS,
    }
  }
  return detectInstallFromWorktree(input.worktree)
}

const LOCKFILE_CANDIDATES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'poetry.lock',
  'Pipfile.lock',
  'package.json',
  'pyproject.toml',
] as const

/** sha256 of the first present lockfile/manifest, or null when none exist. */
export function lockfileFingerprint(worktree: string): string | null {
  for (const name of LOCKFILE_CANDIDATES) {
    try {
      const body = readFileSync(join(worktree, name))
      return createHash('sha256').update(name).update('\0').update(body).digest('hex').slice(0, 16)
    } catch {
      continue
    }
  }
  return null
}

/** True when a previous install left something the agent can import. */
export function worktreeHasDeps(worktree: string): boolean {
  return existsSync(join(worktree, 'node_modules')) || existsSync(join(worktree, '.venv'))
}

/** Per-project package-cache volume: host never reads it, the install step does. */
export function pkgCacheVolume(projectId: string): string {
  return `codesema-pkgcache-${projectId}`
}

// --- level 2 detection: what the repo DECLARES about its own checks --------
// Between an explicit .codesema config and the lockfile heuristic sits the
// repo's own word: the hooks it runs before a push and the CI jobs it gates
// merges on. Those files say precisely which commands the humans consider
// blocking, so parsing them beats guessing from package.json scripts. They
// only ever contribute COMMANDS: the image and the install step keep coming
// from the lockfile detection (a declaration cannot say what to run them in).
//
// The YAML "parsing" below is deliberately partial — indentation + `run:`
// lines, nothing else. No YAML dependency, no anchors, no flow mappings: a
// file it cannot understand simply yields no command, which degrades to the
// lockfile plan instead of breaking anything.

/** Executables a declared command may start with. Anything else is dropped. */
const DECLARED_COMMAND_BINS: ReadonlySet<string> = new Set([
  'bun',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'pytest',
  'cargo',
  'go',
  'make',
  'just',
])

/** Enough to cover typecheck+test+lint across a couple of workspaces. */
const DECLARED_COMMANDS_MAX = 6
/** A check command longer than this is a script in disguise, not a check. */
const DECLARED_COMMAND_MAX_CHARS = 300

/**
 * Shell metacharacters: a declared check is ONE plain command. Anything that
 * chains, redirects, substitutes or templates (lefthook's `{staged_files}`)
 * is refused rather than reinterpreted — the level-2 plan must never turn a
 * hook line into an arbitrary shell program.
 */
const SHELL_METACHARACTERS = /[&|;<>`$(){}\\\n\r]/

function firstToken(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  // A path-qualified binary (./node_modules/.bin/foo) is judged on its name.
  return first.split('/').pop() ?? ''
}

/**
 * Dependency installation, whatever the tool: a declaration only contributes
 * CHECKS — the install step comes from the stack detection and is the only
 * step that may reach the network. Keeping a hook's `npm ci` as a check would
 * run it network-less and fail every time.
 */
const INSTALL_LIKE =
  /\binstall\b|^(npm|pnpm|yarn|bun)\s+(ci|i|add)\b|^go\s+mod\b|^cargo\s+(fetch|update)\b/

/**
 * STRICT filter for a declared command: a single command, no shell plumbing,
 * starting with one of the known build-tool binaries, and not an install.
 * Returns the normalized command or null when it must not be run.
 */
export function acceptDeclaredCommand(raw: string): string | null {
  const command = raw.trim()
  if (!command || command.length > DECLARED_COMMAND_MAX_CHARS) {
    return null
  }
  if (SHELL_METACHARACTERS.test(command) || INSTALL_LIKE.test(command)) {
    return null
  }
  return DECLARED_COMMAND_BINS.has(firstToken(command)) ? command : null
}

/** typecheck → test → lint, then everything else in file order (stable sort). */
function commandRank(command: string): number {
  const c = command.toLowerCase()
  if (/type-?check|\btsc\b|vue-tsc/.test(c)) {
    return 0
  }
  if (/\btests?\b|pytest|vitest|jest|\bspec\b/.test(c)) {
    return 1
  }
  if (/\blint\b|eslint|oxlint|clippy|\bfmt\b|format/.test(c)) {
    return 2
  }
  return 3
}

/** Filter → dedupe → order → cap. The single funnel every declaration goes through. */
function selectDeclaredCommands(raw: string[]): string[] {
  const kept: string[] = []
  for (const candidate of raw) {
    const command = acceptDeclaredCommand(candidate)
    if (command && !kept.includes(command)) {
      kept.push(command)
    }
  }
  return kept
    .map((command, index) => ({ command, index, rank: commandRank(command) }))
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command)
    .slice(0, DECLARED_COMMANDS_MAX)
}

/** One significant YAML line: its indentation and its trimmed content. */
type YamlLine = { indent: number; content: string }

/**
 * Blank lines and full-line comments are dropped; a leading `- ` (sequence
 * item) is folded into the indentation so a step's keys sit one level deeper
 * than the sequence itself. Tabs count as two spaces.
 */
function scanYaml(content: string): YamlLine[] {
  const lines: YamlLine[] = []
  for (const raw of content.split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, '  ')
    const trimmed = expanded.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    let indent = expanded.length - expanded.trimStart().length
    let text = trimmed
    while (text.startsWith('- ')) {
      indent += 2
      text = text.slice(2).trimStart()
    }
    lines.push({ indent, content: text })
  }
  return lines
}

/** Strips surrounding quotes and a trailing ` # comment` from a scalar value. */
function scalarValue(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '').trim()
  const quoted = /^(['"])([\s\S]*)\1$/.exec(withoutComment)
  return (quoted?.[2] ?? withoutComment).trim()
}

/**
 * Every `run:` value inside [from, to). A block scalar (`run: |`) contributes
 * ONE candidate per line — each is then filtered on its own, so a multi-line
 * CI step yields its `bun test` line and drops its `docker login` line.
 */
function runValues(lines: YamlLine[], from: number, to: number): string[] {
  const values: string[] = []
  for (let i = from; i < to; i++) {
    const line = lines[i]
    if (!line) {
      continue
    }
    const match = /^run:\s*(.*)$/.exec(line.content)
    if (!match) {
      continue
    }
    const value = (match[1] ?? '').trim()
    if (value === '' || /^[|>][-+]?\d*$/.test(value)) {
      for (let j = i + 1; j < to; j++) {
        const inner = lines[j]
        if (!inner || inner.indent <= line.indent) {
          break
        }
        values.push(inner.content)
        i = j
      }
      continue
    }
    values.push(scalarValue(value))
  }
  return values
}

/** Hooks worth mining, in the order their commands should run. */
const LEFTHOOK_HOOKS = ['pre-push', 'pre-commit'] as const

/** `run:` values of lefthook's pre-push jobs, then its pre-commit jobs. */
function lefthookRunValues(content: string): string[] {
  const lines = scanYaml(content)
  const sections = new Map<string, { from: number; to: number }>()
  let current: string | null = null
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.indent !== 0) {
      continue
    }
    if (current) {
      sections.set(current, { from: start, to: i })
    }
    current = /^([A-Za-z0-9_.-]+):\s*$/.exec(lines[i]?.content ?? '')?.[1] ?? null
    start = i + 1
  }
  if (current) {
    sections.set(current, { from: start, to: lines.length })
  }
  const values: string[] = []
  for (const hook of LEFTHOOK_HOOKS) {
    const range = sections.get(hook)
    if (range) {
      values.push(...runValues(lines, range.from, range.to))
    }
  }
  return values
}

/** A CI job whose id or name says it verifies something. */
const CI_JOB_RE = /test|lint|typecheck|type-check|check/i

/** `run:` values of the verification jobs of ONE GitHub workflow file. */
function workflowRunValues(content: string): string[] {
  const lines = scanYaml(content)
  const jobsIndex = lines.findIndex(
    (line) => line.indent === 0 && /^jobs:\s*$/.test(line.content ?? ''),
  )
  if (jobsIndex < 0) {
    return []
  }
  let jobsEnd = lines.length
  for (let i = jobsIndex + 1; i < lines.length; i++) {
    if (lines[i]?.indent === 0) {
      jobsEnd = i
      break
    }
  }
  const jobIndent = lines[jobsIndex + 1]?.indent ?? 0
  if (jobIndent <= 0) {
    return []
  }
  const starts: number[] = []
  for (let i = jobsIndex + 1; i < jobsEnd; i++) {
    if (lines[i]?.indent === jobIndent) {
      starts.push(i)
    }
  }
  const values: string[] = []
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] ?? 0
    const to = starts[k + 1] ?? jobsEnd
    const id = /^([A-Za-z0-9_.-]+):/.exec(lines[from]?.content ?? '')?.[1]
    if (!id) {
      continue
    }
    const body = lines.slice(from + 1, to)
    const bodyIndent = body.reduce(
      (min, line) => Math.min(min, line.indent),
      Number.MAX_SAFE_INTEGER,
    )
    // Only the JOB's own name counts; a step named "test" inside a "deploy"
    // job must not pull the whole job in.
    const name = body.find(
      (line) => line.indent === bodyIndent && /^name:\s*\S/.test(line.content),
    )?.content
    const label = name ? scalarValue(name.slice('name:'.length)) : ''
    if (!CI_JOB_RE.test(id) && !CI_JOB_RE.test(label)) {
      continue
    }
    values.push(...runValues(lines, from, to))
  }
  return values
}

/** A repo file that may declare check commands, with its content. */
export type DeclarationFile = { path: string; content: string }

/** Commands the repo declares for itself, and which file they came from. */
export type DeclaredChecks = { commands: string[]; source: 'lefthook' | 'ci' }

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? ''
}

const LEFTHOOK_FILES: ReadonlySet<string> = new Set([
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
])

function isWorkflowPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.includes('.github/workflows/') && /\.ya?ml$/.test(normalized)
}

/**
 * PURE level-2 detection. Lefthook wins over CI: a pre-push hook is what the
 * humans actually run before sharing code, CI is the fallback statement of
 * the same intent. Null when nothing survives the strict filter — the caller
 * then keeps the lockfile plan untouched.
 */
export function detectFromDeclarations(files: DeclarationFile[]): DeclaredChecks | null {
  const byPath = (a: DeclarationFile, b: DeclarationFile) => a.path.localeCompare(b.path)
  const lefthook = files
    .filter((file) => LEFTHOOK_FILES.has(basename(file.path)))
    .toSorted(byPath)
    .flatMap((file) => lefthookRunValues(file.content))
  const fromLefthook = selectDeclaredCommands(lefthook)
  if (fromLefthook.length > 0) {
    return { commands: fromLefthook, source: 'lefthook' }
  }
  const ci = files
    .filter((file) => isWorkflowPath(file.path))
    .toSorted(byPath)
    .flatMap((file) => workflowRunValues(file.content))
  const fromCi = selectDeclaredCommands(ci)
  return fromCi.length > 0 ? { commands: fromCi, source: 'ci' } : null
}

/** Per-file read cap: a declaration file bigger than this is not one. */
const DECLARATION_FILE_MAX_BYTES = 128 * 1024
/** A repo with more workflows than this gets its first ones, alphabetically. */
const WORKFLOW_FILES_MAX = 20

function readBounded(path: string): string | null {
  try {
    if (statSync(path).size > DECLARATION_FILE_MAX_BYTES) {
      return null
    }
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Disk side of the level-2 detection; any read failure just yields fewer files. */
export function readDeclarationFiles(root: string): DeclarationFile[] {
  const files: DeclarationFile[] = []
  for (const name of LEFTHOOK_FILES) {
    const content = readBounded(join(root, name))
    if (content !== null) {
      files.push({ path: name, content })
    }
  }
  let workflows: string[] = []
  try {
    workflows = readdirSync(join(root, '.github', 'workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .toSorted()
      .slice(0, WORKFLOW_FILES_MAX)
  } catch {
    workflows = []
  }
  for (const name of workflows) {
    const content = readBounded(join(root, '.github', 'workflows', name))
    if (content !== null) {
      files.push({ path: `.github/workflows/${name}`, content })
    }
  }
  return files
}

/** Explicit config → plan. Commands are the essence: none = unconfigured. */
export function planFromConfig(config: ChecksConfig): ChecksPlan | null {
  const commands = (config.commands ?? []).filter((command) => command.trim() !== '')
  if (commands.length === 0) {
    return null
  }
  return {
    image: config.image?.trim() || DEFAULT_CHECKS_IMAGE,
    install: config.install ?? null,
    commands,
    network: config.network === true,
    timeoutSeconds:
      Number.isInteger(config.timeoutSeconds) && (config.timeoutSeconds as number) > 0
        ? (config.timeoutSeconds as number)
        : DEFAULT_CHECK_TIMEOUT_SECONDS,
    // An explicit .codesema config — including the one an applied setup
    // proposal just wrote — is always labelled 'config'.
    source: 'config',
  }
}

/** Disk-reading wrapper around the pure detectChecks; any read failure = unconfigured. */
export function detectChecksFromWorktree(worktree: string): ChecksPlan | null {
  let files: string[]
  try {
    files = readdirSync(worktree)
  } catch {
    return null
  }
  const readIfPresent = (name: string): string | null => {
    if (!files.includes(name)) {
      return null
    }
    try {
      return readFileSync(join(worktree, name), 'utf8')
    } catch {
      return null
    }
  }
  let packageJson: { scripts?: Record<string, unknown> } | null = null
  const rawPackageJson = readIfPresent('package.json')
  if (rawPackageJson) {
    try {
      packageJson = JSON.parse(rawPackageJson) as { scripts?: Record<string, unknown> } | null
    } catch {
      packageJson = null
    }
  }
  return detectChecks({ files, packageJson, pyproject: readIfPresent('pyproject.toml') })
}

/**
 * THE precedence, in one place: explicit repo config, then what the repo
 * declares about itself (lefthook / CI), then the lockfile heuristic.
 *
 * Level 2 only ever REPLACES the commands: the image and the install step
 * still come from the stack detection, so a declaration alone (no lockfile
 * match, hence no image) yields no plan at all. An explicit config is taken
 * as-is — configuring checks and getting hook commands instead would be a
 * silent override of an explicit decision.
 */
export function resolveChecksPlan(input: {
  worktree: string
  config?: ChecksConfig | null
}): ChecksPlan | null {
  if (input.config) {
    return planFromConfig(input.config)
  }
  const detected = detectChecksFromWorktree(input.worktree)
  if (!detected) {
    return null
  }
  const declared = detectFromDeclarations(readDeclarationFiles(input.worktree))
  // Level 2 replaces the commands AND the provenance label: what runs came
  // from lefthook/CI even though the image still comes from the lockfile.
  return declared ? { ...detected, commands: declared.commands, source: declared.source } : detected
}

export type RunChecksOptions = {
  /** The task's worktree — the ONLY host path the container ever sees. */
  worktree: string
  /** Explicit repo config; null/absent falls back to auto-detection. */
  config?: ChecksConfig | null
  /** When set, the install step mounts `pkgCacheVolume(projectId)` at /cache. */
  projectId?: string
  /** Worktree HEAD stamped on the result (recorded, never executed). */
  headSha: string
  /**
   * Progress snapshots: fired once with the initial 'running' state and again
   * after each completed step. The FINAL state is only returned, never fired —
   * the caller persists/broadcasts both, without double writes.
   */
  onUpdate?: (snapshot: TaskChecks) => void
  /** Test seam; the default drives the real docker/podman via execFile. */
  execFn?: ExecFn
}

type StepOutcome = { result: TaskCheckResult; hardError: string | null }

type RunStepInput = {
  exec: ExecFn
  runtime: string
  step: { command: string; network: boolean }
  plan: ChecksPlan
  worktree: string
  /** READ-ONLY `-v` arguments exposing the repo's git directory; see container-git.ts. */
  gitMounts: readonly string[]
  /** Extra docker/podman argv (cache volume, --user, --userns=keep-id). */
  extraArgs?: readonly string[]
}

/** One containerized step. Kills the container on timeout (killing the client alone leaves it running). */
async function runStep(input: RunStepInput): Promise<StepOutcome> {
  const { exec, runtime, step, plan, worktree } = input
  // A unique name so a timed-out container can be killed by name; --rm reaps it.
  const name = `codesema-checks-${randomBytes(6).toString('hex')}`
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '-v',
    `${worktree}:${CHECKS_WORK_DIR}:rw`,
    '-w',
    CHECKS_WORK_DIR,
    // Check commands are the repo's own: hooks, version stamps and test rigs
    // routinely shell out to git, which a linked worktree alone cannot answer.
    ...input.gitMounts,
    ...(input.extraArgs ?? []),
    ...gitSafeDirectoryEnvArgs(CHECKS_WORK_DIR),
    ...(step.network ? [] : ['--network', 'none']),
    '--cpus',
    '2',
    '--memory',
    '2g',
    plan.image,
    'sh',
    '-lc',
    input.extraArgs && input.extraArgs.length > 0
      ? `mkdir -p "$HOME" "$npm_config_cache" "$BUN_INSTALL_CACHE_DIR" "$PIP_CACHE_DIR"; ${step.command}`
      : step.command,
  ]
  const startedAt = Date.now()
  const run = await exec(runtime, args, { timeoutMs: plan.timeoutSeconds * 1000 })
  const duration_ms = Date.now() - startedAt
  // Interleaving is lost across the two pipes; stdout-then-stderr keeps the
  // stderr end (where compilers put the verdict) inside the bounded tail.
  const tail = (run.stdout + run.stderr).slice(-TASK_CHECK_TAIL_MAX)
  if (run.timedOut) {
    // Best-effort: the docker client died but the container is still running.
    void exec(runtime, ['kill', name], { timeoutMs: 10_000 }).catch(() => {})
    return {
      result: { command: step.command, status: 'timeout', exit_code: null, duration_ms, tail },
      hardError: null,
    }
  }
  if (run.failure !== null) {
    return {
      result: { command: step.command, status: 'failed', exit_code: null, duration_ms, tail },
      hardError: run.failure,
    }
  }
  return {
    result: {
      command: step.command,
      status: run.code === 0 ? 'passed' : 'failed',
      exit_code: run.code,
      duration_ms,
      tail,
    },
    hardError: null,
  }
}

/**
 * Runs the plan sequentially in ephemeral containers and returns the final
 * TaskChecks (never rejects: engine problems become status 'error' with a
 * readable message). An install failure skips every remaining step (nothing
 * can pass on a broken environment); a failing CHECK does not — later checks
 * still run so one run reports everything.
 */
export async function runChecks(opts: RunChecksOptions): Promise<TaskChecks> {
  const snapshot: TaskChecks = {
    head_sha: opts.headSha,
    started_at: new Date().toISOString(),
    finished_at: null,
    status: 'running',
    checks: [],
    error: null,
  }
  const finish = (status: TaskChecks['status'], error: string | null = null): TaskChecks => ({
    ...snapshot,
    status,
    error,
    finished_at: new Date().toISOString(),
  })
  const plan = resolveChecksPlan({
    worktree: opts.worktree,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  })
  if (!plan) {
    // Nothing resolved: there is no provenance to claim.
    return finish('unconfigured')
  }
  // Stamped once the plan exists, so every snapshot from here on (including
  // the ones `finish` derives) carries it.
  snapshot.source = plan.source
  opts.onUpdate?.({ ...snapshot })
  const runtime = await containerRuntime(opts.execFn)
  if (!runtime) {
    return finish(
      'error',
      'no container runtime found: install docker or podman to run checks in a sandbox',
    )
  }
  const exec = opts.execFn ?? defaultExec
  const git = prepareContainerGit({ worktree: opts.worktree, workDir: CHECKS_WORK_DIR })
  const gitMounts = git?.mountArgs ?? []
  const installExtra = opts.projectId
    ? await ensureInstallExtraArgs({
        exec,
        runtime,
        projectId: opts.projectId,
      })
    : []
  const steps = [
    ...(plan.install ? [{ command: plan.install, network: plan.network, install: true }] : []),
    ...plan.commands.map((command) => ({ command, network: false, install: false })),
  ]
  let skipRest = false
  let hardError: string | null = null
  for (const step of steps) {
    if (skipRest) {
      snapshot.checks.push({
        command: step.command,
        status: 'skipped',
        exit_code: null,
        duration_ms: 0,
        tail: '',
      })
      continue
    }
    const { result, hardError: failure } = await runStep({
      exec,
      runtime,
      step,
      plan,
      worktree: opts.worktree,
      gitMounts,
      ...(step.install && installExtra.length > 0 ? { extraArgs: installExtra } : {}),
    })
    snapshot.checks.push(result)
    if (failure !== null) {
      // Spawn-level breakage (runtime vanished mid-run): the rest cannot run.
      hardError = failure
      skipRest = true
    } else if (step.install && result.status !== 'passed') {
      skipRest = true
    }
    opts.onUpdate?.({ ...snapshot, checks: [...snapshot.checks] })
  }
  if (hardError !== null) {
    return finish('error', hardError)
  }
  const failed = snapshot.checks.some((c) => c.status === 'failed' || c.status === 'timeout')
  return finish(failed ? 'failed' : 'passed')
}

const PKG_CACHE_DIR = '/cache'

async function runtimeLooksLikePodman(runtime: string, exec: ExecFn): Promise<boolean> {
  if (/(^|\/)podman$/.test(runtime)) {
    return true
  }
  const probe = await exec(runtime, ['--version'], { timeoutMs: 20_000 })
  return /podman/i.test(`${probe.stdout}${probe.stderr}`)
}

async function ensureInstallExtraArgs(opts: {
  exec: ExecFn
  runtime: string
  projectId: string
  uid?: number
  gid?: number
  podman?: boolean
}): Promise<string[]> {
  const volume = pkgCacheVolume(opts.projectId)
  await opts.exec(opts.runtime, ['volume', 'create', volume], { timeoutMs: 30_000 })
  const uid = opts.uid ?? process.getuid?.() ?? 1000
  const gid = opts.gid ?? process.getgid?.() ?? 1000
  const podman = opts.podman ?? (await runtimeLooksLikePodman(opts.runtime, opts.exec))
  const uidArgs = podman ? ['--userns=keep-id'] : ['--user', `${uid}:${gid}`]
  if (!podman) {
    // The cache volume is born root:root. Without keep-id, the install user
    // cannot mkdir inside it unless we chown first.
    await opts.exec(
      opts.runtime,
      [
        'run',
        '--rm',
        '-v',
        `${volume}:${PKG_CACHE_DIR}`,
        'busybox',
        'chown',
        '-R',
        `${uid}:${gid}`,
        PKG_CACHE_DIR,
      ],
      { timeoutMs: 60_000 },
    )
  }
  return [
    '-v',
    `${volume}:${PKG_CACHE_DIR}`,
    '-e',
    `HOME=${PKG_CACHE_DIR}/home`,
    '-e',
    `npm_config_cache=${PKG_CACHE_DIR}/npm`,
    '-e',
    `BUN_INSTALL_CACHE_DIR=${PKG_CACHE_DIR}/bun`,
    '-e',
    `PIP_CACHE_DIR=${PKG_CACHE_DIR}/pip`,
    '-e',
    `XDG_CACHE_HOME=${PKG_CACHE_DIR}`,
    ...uidArgs,
  ]
}

/** Wall-clock budget for a criterion's ad hoc `[proof:command ...]` check (D17), kept short on purpose: this runs inline in the review path, never as a background job. */
export const AD_HOC_CHECK_DEFAULT_TIMEOUT_SECONDS = 60

export type RunAdHocCheckOptions = {
  /** The task's worktree: the ONLY host path the container ever sees, same as `RunChecksOptions`. */
  worktree: string
  /** The criterion's `[proof:command ...]` argument, run verbatim. */
  command: string
  /** Defaults to `DEFAULT_CHECKS_IMAGE`: a criterion's command names no stack, so nothing better can be inferred. */
  image?: string
  timeoutSeconds?: number
  execFn?: ExecFn
}

/**
 * Runs ONE command in an ephemeral checks container, for a `[proof:command
 * ...]` criterion (D17) whose command is not among the task's own
 * `TaskChecks.checks[]`. `task-criteria-gate.ts`'s `resolveMechanicalCriteria`
 * is the only caller. No install step (the worktree carries whatever
 * dependencies its last checks run, or the agent's own turn, left behind)
 * and never network, unlike a checks run's own install step: a criterion's
 * command is not trusted with either. Never throws: an absent container
 * runtime is reported as a synthetic 'failed' result, the same discipline
 * `runChecks` itself follows for every engine-level problem.
 */
export async function runAdHocCheck(opts: RunAdHocCheckOptions): Promise<TaskCheckResult> {
  const exec = opts.execFn ?? defaultExec
  const runtime = await containerRuntime(opts.execFn)
  if (!runtime) {
    return {
      command: opts.command,
      status: 'failed',
      exit_code: null,
      duration_ms: 0,
      tail: 'no container runtime found: install docker or podman to run this check',
    }
  }
  const git = prepareContainerGit({ worktree: opts.worktree, workDir: CHECKS_WORK_DIR })
  const { result } = await runStep({
    exec,
    runtime,
    step: { command: opts.command, network: false },
    plan: {
      image: opts.image?.trim() || DEFAULT_CHECKS_IMAGE,
      install: null,
      commands: [],
      network: false,
      timeoutSeconds: opts.timeoutSeconds ?? AD_HOC_CHECK_DEFAULT_TIMEOUT_SECONDS,
      source: 'config',
    },
    worktree: opts.worktree,
    gitMounts: git?.mountArgs ?? [],
  })
  return result
}

/** How much of a non-passed/skipped check's tail a prompt chapter spends, far smaller than `TASK_CHECK_TAIL_MAX`: this travels in a model's context, not a log. */
export const CHECKS_CHAPTER_TAIL_MAX = 600

/**
 * The mandatory chapter a task's checks contribute to a review or fix prompt
 * (D16). The commands already ran, in an isolated container, before this
 * prompt was ever built: the whole point of this chapter is that neither the
 * reviewer nor a fixing agent has to re-derive a check's outcome from the
 * diff. A status here is a fact of THIS run, not an inference to make again.
 */
export function buildChecksChapter(
  checks: TaskChecks,
  opts: { purpose?: 'review' | 'fix' } = {},
): string {
  const header = `Repository checks, MANDATORY chapter (${checks.status}${
    checks.source ? `, source: ${checks.source}` : ''
  }):`
  if (checks.status === 'unconfigured') {
    return [header, 'No checks are detected or configured for this repository.'].join('\n')
  }
  if (checks.status === 'error') {
    return [
      header,
      `The checks engine itself failed to run: ${checks.error ?? 'unknown error'}.`,
    ].join('\n')
  }
  const lines = checks.checks.map((check) => {
    const line = `- ${check.command}: ${check.status}`
    // Only a check that is neither green nor merely skipped earns its tail.
    // A pass needs no evidence and a skip has none to show.
    return check.status === 'passed' || check.status === 'skipped'
      ? line
      : `${line}\n  ${check.tail.slice(-CHECKS_CHAPTER_TAIL_MAX)}`
  })
  const closing =
    (opts.purpose ?? 'review') === 'fix'
      ? 'What must still pass: make every failed or timed-out command above exit 0. These already ran once against your last commit and will run again against your next one.'
      : 'These commands already ran in an isolated container: a passed check is not to be re-derived from the diff, and a failed or timed-out one is a fact, not a hypothesis to weigh against the code.'
  return [header, ...lines, '', closing].join('\n')
}

export type BootstrapInstallStatus = 'passed' | 'skipped' | 'failed' | 'unconfigured'

export type BootstrapInstallResult = {
  status: BootstrapInstallStatus
  command: string | null
  fingerprint: string | null
  detail: string
}

export type BootstrapWorktreeInstallOptions = {
  worktree: string
  projectId: string
  config?: ChecksConfig | null
  /** Last install's lockfile hash, from the task record. */
  previousFingerprint?: string | null
  uid?: number
  gid?: number
  podman?: boolean
  execFn?: ExecFn
  /** Fired once an install is about to run (not on skip / unconfigured). */
  onStart?: (command: string) => void
}

/**
 * Installs the worktree's dependencies in a checks-shaped container (network
 * ON, shared package-cache volume) BEFORE the agent turn. Skips when the
 * lockfile hash matches the previous install AND node_modules/.venv is still
 * there — a rebuilt empty worktree always reinstalls.
 */
export async function bootstrapWorktreeInstall(
  opts: BootstrapWorktreeInstallOptions,
): Promise<BootstrapInstallResult> {
  const plan = resolveInstallPlan({
    worktree: opts.worktree,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  })
  const fingerprint = lockfileFingerprint(opts.worktree)
  if (!plan) {
    return { status: 'unconfigured', command: null, fingerprint, detail: '' }
  }
  if (fingerprint && fingerprint === opts.previousFingerprint && worktreeHasDeps(opts.worktree)) {
    return {
      status: 'skipped',
      command: plan.install,
      fingerprint,
      detail: 'lockfile unchanged',
    }
  }
  opts.onStart?.(plan.install)
  const runtime = await containerRuntime(opts.execFn)
  if (!runtime) {
    return {
      status: 'failed',
      command: plan.install,
      fingerprint,
      detail: 'no container runtime found: install docker or podman to install dependencies',
    }
  }
  const exec = opts.execFn ?? defaultExec
  const extraArgs = await ensureInstallExtraArgs({
    exec,
    runtime,
    projectId: opts.projectId,
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    ...(opts.podman !== undefined ? { podman: opts.podman } : {}),
  })
  const git = prepareContainerGit({ worktree: opts.worktree, workDir: CHECKS_WORK_DIR })
  const { result, hardError } = await runStep({
    exec,
    runtime,
    step: { command: plan.install, network: true },
    plan: {
      image: plan.image,
      install: plan.install,
      commands: [],
      network: true,
      timeoutSeconds: plan.timeoutSeconds,
      source: 'scripts',
    },
    worktree: opts.worktree,
    gitMounts: git?.mountArgs ?? [],
    extraArgs,
  })
  if (hardError !== null || result.status !== 'passed') {
    return {
      status: 'failed',
      command: plan.install,
      fingerprint,
      detail: hardError ?? result.tail.slice(-400) ?? `exit ${String(result.exit_code)}`,
    }
  }
  return { status: 'passed', command: plan.install, fingerprint, detail: '' }
}
