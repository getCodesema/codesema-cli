// Checks setup agent: the LAST resort of the checks configuration ladder.
// When neither an explicit .codesema config, nor the repo's declarations
// (lefthook/CI), nor the lockfile heuristic produce a usable plan, the user
// can ask their own agent to propose one.
//
// Three properties make this safe to expose in the UI:
//  1. The agent runs READ-ONLY — hardenedReviewCommand cuts its tools, MCP
//     servers and repo-provided settings, agentEnv strips the environment. It
//     is a pure text transformer here, exactly like the review agent.
//  2. The agent reads NOTHING itself: codesema collects the relevant files,
//     truncates them and puts them IN the prompt. What it cannot see, it
//     cannot leak.
//  3. The answer is a PROPOSAL held in memory only. Nothing reaches disk
//     until an explicit apply, and everything is re-validated through a
//     whitelist first: an image that is not an image, a command that is not a
//     check, an absurd timeout — all refused or clamped before a human ever
//     sees them.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnv, hardenedReviewCommand, runAgent, type AgentRunOptions } from './agent.js'
import { writeChecksConfig, type ChecksConfig } from './repo-config.js'
import { DEFAULT_CHECK_TIMEOUT_SECONDS, readDeclarationFiles } from './task-checks.js'

/** The setup agent answers from a prompt; it never works, so 2 minutes is generous. */
export const CHECKS_SETUP_TIMEOUT_MS = 120_000

/** Per-file slice put in the prompt: enough to read a config, never a whole source tree. */
export const SETUP_FILE_MAX_CHARS = 4_000
/** Total prompt budget for the collected files. */
export const SETUP_TOTAL_MAX_CHARS = 30_000

/** One file shown to the setup agent: repo-relative path + bounded content. */
export type SetupFile = { path: string; content: string }

/** A checks configuration the agent proposes; nothing here is on disk yet. */
export type ChecksProposal = {
  image: string
  install: string | null
  commands: string[]
  network: boolean
  timeoutSeconds: number
  rationale: string
}

/** Per-project state of the proposal flow (GET /api/projects/:id/checks-setup). */
export type ChecksSetupState =
  | { status: 'idle' }
  | { status: 'running'; started_at: string }
  | { status: 'ready'; proposal: ChecksProposal }
  | { status: 'error'; error: string }

// --- sanitizing ------------------------------------------------------------

/**
 * A plausible docker reference: lowercase path segments, optional tag and
 * optional digest. Nothing else — no spaces, no shell, no options. This is
 * what stops `evil; rm -rf /` from ever reaching a `docker run` argv.
 */
const IMAGE_RE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/

const IMAGE_MAX_CHARS = 200
const COMMAND_MAX_CHARS = 300
const COMMANDS_MAX = 8
const RATIONALE_MAX_CHARS = 500
const TIMEOUT_MIN_SECONDS = 30
const TIMEOUT_MAX_SECONDS = 3_600

/** Binaries a proposed CHECK may start with (same spirit as the declaration filter). */
const PROPOSAL_COMMAND_BINS: ReadonlySet<string> = new Set([
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

/** Installers additionally allowed in the install step, which is not a check. */
const PROPOSAL_INSTALL_BINS: ReadonlySet<string> = new Set([
  ...PROPOSAL_COMMAND_BINS,
  'pip',
  'pip3',
  'poetry',
  'uv',
  'bundle',
  'composer',
])

/**
 * Everything that could turn one command into a shell program. `&` is absent
 * on purpose: `&&` is handled separately (a monorepo check legitimately reads
 * `cd packages/cli && bun test`), a lone `&` is refused below.
 */
const FORBIDDEN_CHARS = /[;|<>`$(){}\\\n\r]/

function firstToken(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first.split('/').pop() ?? ''
}

/**
 * Validates one proposed command. `cd <dir> && <tool> ...` is tolerated (a
 * monorepo package is a real case), any other chaining, redirection or
 * substitution is refused. Returns the normalized command or null.
 */
function acceptProposedCommand(raw: unknown, bins: ReadonlySet<string>): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const command = raw.trim()
  if (!command || command.length > COMMAND_MAX_CHARS) {
    return null
  }
  // Only the exact `&&` pair is allowed: strip the pairs and any surviving
  // ampersand (a lone `&` backgrounding a process, a stray `&&&`) is a refusal.
  if (FORBIDDEN_CHARS.test(command) || command.replace(/&&/g, '').includes('&')) {
    return null
  }
  const parts = command.split('&&').map((part) => part.trim())
  if (parts.some((part) => part === '')) {
    return null
  }
  for (const part of parts) {
    const bin = firstToken(part)
    if (bin !== 'cd' && !bins.has(bin)) {
      return null
    }
  }
  // A command made only of `cd` runs nothing: it is a truncated answer.
  return parts.every((part) => firstToken(part) === 'cd') ? null : command
}

/** Control characters would corrupt the UI and the JSON on disk alike. */
function plainText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') {
    return ''
  }
  // \p{Cc} = the Unicode control category (C0 and C1 alike).
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, max)
}

/**
 * Whitelist revalidation of whatever the agent answered. Null when the
 * proposal cannot be trusted as a whole — a refused image or zero usable
 * command leaves nothing to show a human. Everything else is filtered
 * (commands) or clamped (timeout) rather than rejected.
 */
export function sanitizeChecksProposal(raw: unknown): ChecksProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const p = raw as Record<string, unknown>
  const image = typeof p.image === 'string' ? p.image.trim() : ''
  if (!image || image.length > IMAGE_MAX_CHARS || !IMAGE_RE.test(image)) {
    return null
  }
  const commands: string[] = []
  if (Array.isArray(p.commands)) {
    for (const candidate of p.commands) {
      const command = acceptProposedCommand(candidate, PROPOSAL_COMMAND_BINS)
      if (command && !commands.includes(command)) {
        commands.push(command)
      }
      if (commands.length >= COMMANDS_MAX) {
        break
      }
    }
  }
  if (commands.length === 0) {
    return null
  }
  const timeout = Number.isFinite(p.timeoutSeconds) ? Math.round(p.timeoutSeconds as number) : null
  return {
    image,
    install: acceptProposedCommand(p.install, PROPOSAL_INSTALL_BINS),
    commands,
    network: p.network === true,
    timeoutSeconds:
      timeout === null
        ? DEFAULT_CHECK_TIMEOUT_SECONDS
        : Math.min(TIMEOUT_MAX_SECONDS, Math.max(TIMEOUT_MIN_SECONDS, timeout)),
    rationale: plainText(p.rationale, RATIONALE_MAX_CHARS),
  }
}

/** The proposal as it will be written under the `checks` key. */
export function proposalToChecksConfig(proposal: ChecksProposal): ChecksConfig {
  return {
    image: proposal.image,
    install: proposal.install,
    commands: proposal.commands,
    network: proposal.network,
    timeoutSeconds: proposal.timeoutSeconds,
  }
}

// --- agent output parsing --------------------------------------------------

/** Index of the '}' closing the object opened at `start`, string- and escape-aware. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }
  return -1
}

/** Whole output, then fenced blocks, then every balanced {...} — same ladder as the review parser. */
function* jsonCandidates(text: string): Generator<string> {
  yield text
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (match[1]) {
      yield match[1].trim()
    }
  }
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    const end = balancedEnd(text, i)
    if (end > i) {
      yield text.slice(i, end + 1)
    }
  }
}

/**
 * Tolerant extraction: agents wrap their JSON in prose, in code fences, or in
 * both. The first candidate that parses into an object carrying `commands`
 * wins; otherwise the first object that parses at all. Null when the output
 * holds no JSON object.
 */
export function extractProposalJson(raw: string): unknown | null {
  let fallback: unknown = null
  let sawObject = false
  for (const candidate of jsonCandidates(raw.trim())) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue
    }
    if ('commands' in (parsed as Record<string, unknown>)) {
      return parsed
    }
    if (!sawObject) {
      fallback = parsed
      sawObject = true
    }
  }
  return sawObject ? fallback : null
}

// --- prompt ----------------------------------------------------------------

/** Root files worth showing verbatim; the lockfiles are listed, never dumped. */
const ROOT_SETUP_FILES = [
  'package.json',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  '.justfile',
  'Taskfile.yml',
  'moon.yml',
  'turbo.json',
  'nx.json',
  'pnpm-workspace.yaml',
  'deno.json',
  'pyproject.toml',
  'tox.ini',
  'Cargo.toml',
  'go.mod',
  'mise.toml',
  '.tool-versions',
  '.nvmrc',
  '.python-version',
  '.gitlab-ci.yml',
]

/** Sub-package manifests: at most this many, so a 200-package monorepo stays bounded. */
const WORKSPACE_MANIFESTS_MAX = 12

/** A missing file, a directory or an oversized blob all read as "nothing to show". */
function readFileIfPresent(path: string): string | null {
  try {
    return statSync(path).size > 1024 * 1024 ? null : readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Workspace globs are only honored in their simple `dir/*` form — enough for the usual monorepos. */
function workspaceManifests(repoRoot: string, rootPackageJson: string | null): SetupFile[] {
  if (!rootPackageJson) {
    return []
  }
  let patterns: unknown
  try {
    patterns = (JSON.parse(rootPackageJson) as { workspaces?: unknown }).workspaces
  } catch {
    return []
  }
  const globs = Array.isArray(patterns)
    ? patterns
    : Array.isArray((patterns as { packages?: unknown } | null)?.packages)
      ? ((patterns as { packages: unknown[] }).packages as unknown[])
      : []
  const files: SetupFile[] = []
  for (const glob of globs) {
    if (typeof glob !== 'string' || !/^[A-Za-z0-9._/-]+\/\*$/.test(glob)) {
      continue
    }
    const dir = glob.slice(0, -2)
    let entries: string[] = []
    try {
      entries = readdirSync(join(repoRoot, dir)).toSorted()
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= WORKSPACE_MANIFESTS_MAX) {
        return files
      }
      const relative = `${dir}/${entry}/package.json`
      const content = readFileIfPresent(join(repoRoot, dir, entry, 'package.json'))
      if (content !== null) {
        files.push({ path: relative, content })
      }
    }
  }
  return files
}

/**
 * Everything the setup agent is allowed to see, read by CODESEMA: the repo's
 * declarations (lefthook, CI), its root manifests and its workspace package
 * manifests. Truncated per file and in total — the agent gets a bounded
 * picture, never the repository.
 */
export function collectSetupFiles(repoRoot: string): SetupFile[] {
  const collected: SetupFile[] = []
  const rootPackageJson = readFileIfPresent(join(repoRoot, 'package.json'))
  for (const name of ROOT_SETUP_FILES) {
    const content = readFileIfPresent(join(repoRoot, name))
    if (content !== null) {
      collected.push({ path: name, content })
    }
  }
  collected.push(...readDeclarationFiles(repoRoot))
  collected.push(...workspaceManifests(repoRoot, rootPackageJson))

  const files: SetupFile[] = []
  let total = 0
  for (const file of collected) {
    if (total >= SETUP_TOTAL_MAX_CHARS) {
      break
    }
    const room = Math.min(SETUP_FILE_MAX_CHARS, SETUP_TOTAL_MAX_CHARS - total)
    const content = file.content.slice(0, room)
    files.push({ path: file.path, content })
    total += content.length
  }
  return files
}

/** Top-level entry names: how the agent recognizes the stack (lockfiles included). */
function rootEntries(repoRoot: string): string[] {
  try {
    return readdirSync(repoRoot).toSorted().slice(0, 120)
  } catch {
    return []
  }
}

const SETUP_INSTRUCTIONS = `You configure the containerized CHECKS of a repository for codesema.

codesema verifies an agent's work by running the repository's own checks inside an EPHEMERAL container mounted on a git worktree: first ONE install step (the only step allowed to reach the network), then each check command in turn with NO network at all.

Answer with ONE JSON object and NOTHING else:
{"image":"...","install":"..." or null,"commands":["..."],"network":true or false,"timeoutSeconds":300,"rationale":"..."}

Rules:
- image: an existing public docker image that already ships the toolchain (e.g. "oven/bun:1", "node:26", "python:3.12", "rust:1"). No build step, no registry credentials.
- install: the ONE command installing the dependencies, or null when there is nothing to install. It may also start with pip, pip3, poetry, uv, bundle or composer.
- commands: 1 to 6 check commands (typecheck, tests, lint), each a single command starting with one of: bun, npm, npx, pnpm, yarn, node, pytest, cargo, go, make, just. A leading "cd <dir> && " is allowed for a package of a monorepo. No other shell plumbing (no pipes, no redirections, no substitutions).
- network: true when the INSTALL step needs the network (it almost always does).
- timeoutSeconds: per-command budget, between 30 and 3600.
- rationale: at most 500 characters, explaining the choice in the user's terms.

Prefer the commands the repository already declares for itself (git hooks, CI jobs) over commands you invent. Refuse to guess: if the repository shows no runnable check, answer with an empty "commands" array.

You have NO tools and NO filesystem access: the files below are everything you get, already read for you and truncated. Do not ask questions, do not explain outside the JSON. Output the JSON object now.`

/** The complete prompt: instructions, the repo's root listing, then the files verbatim. */
export function buildChecksSetupPrompt(input: { entries: string[]; files: SetupFile[] }): string {
  // A quote in a path would break the tag it sits in: paths are labels here,
  // never anything the agent (or codesema) acts on.
  const blocks = input.files.map(
    (file) => `<file path="${file.path.replace(/"/g, "'")}">\n${file.content}\n</file>`,
  )
  return [
    SETUP_INSTRUCTIONS,
    `<repo_entries>\n${input.entries.join('\n')}\n</repo_entries>`,
    ...blocks,
  ].join('\n\n')
}

// --- runner ----------------------------------------------------------------

export type ChecksSetupResult = { ok: true } | { ok: false; code: number; error: string }

/** The minimum a project must expose for a setup run (projects.ts's Project fits). */
export type ChecksSetupProject = { id: string; path: string }

export type ChecksSetupRunner = {
  /** Current proposal state of one project; 'idle' when nothing ran. */
  status: (projectId: string) => ChecksSetupState
  /** Starts the read-only agent; ok means STARTED (the result lands on the state + SSE). */
  start: (project: ChecksSetupProject) => ChecksSetupResult
  /** Writes the ready proposal to the repo's .codesema/config.json and clears it. */
  apply: (project: ChecksSetupProject) => ChecksSetupResult
}

export type CreateChecksSetupRunnerOptions = {
  /** Fallback agent command; empty means no agent (every start 501s). */
  command: string
  /**
   * Per-project agent (T1.4). When set, a checks proposal for project B uses
   * B's resolved command, not the launch-repo fallback.
   */
  resolveCommand?: (projectPath: string) => string
  timeoutMs?: number
  /** Test seam: the default spawns the real agent (read-only, minimal env). */
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
  /** Test seam for the disk collection. */
  collectFilesFn?: (repoRoot: string) => SetupFile[]
  /** Test seam: the default writes the repo's .codesema/config.json. */
  writeChecksConfigFn?: typeof writeChecksConfig
  /** Broadcast hook: fired on every state transition (SSE 'checks_proposal'). */
  onState?: (projectId: string, state: ChecksSetupState) => void
}

const IDLE: ChecksSetupState = { status: 'idle' }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createChecksSetupRunner(opts: CreateChecksSetupRunnerOptions): ChecksSetupRunner {
  // In memory ONLY: a proposal is a suggestion, and a workspace restart is a
  // perfectly good way to forget one.
  const states = new Map<string, ChecksSetupState>()
  const collect = opts.collectFilesFn ?? collectSetupFiles
  const write = opts.writeChecksConfigFn ?? writeChecksConfig
  const run = opts.runAgentFn ?? runAgent
  const timeoutMs = opts.timeoutMs ?? CHECKS_SETUP_TIMEOUT_MS

  const setState = (projectId: string, state: ChecksSetupState): void => {
    states.set(projectId, state)
    opts.onState?.(projectId, state)
  }

  return {
    status: (projectId) => states.get(projectId) ?? IDLE,

    start(project) {
      const command = (opts.resolveCommand?.(project.path) ?? opts.command).trim()
      if (!command) {
        return { ok: false, code: 501, error: 'no agent configured' }
      }
      if (states.get(project.id)?.status === 'running') {
        return { ok: false, code: 409, error: 'a checks setup is already running' }
      }
      setState(project.id, { status: 'running', started_at: new Date().toISOString() })
      void (async () => {
        try {
          const files = collect(project.path)
          const prompt = buildChecksSetupPrompt({ entries: rootEntries(project.path), files })
          const env = agentEnv(command)
          // Read-only by construction: hardened command (no tools, no MCP, no
          // repo settings) and a minimal environment, exactly like a review.
          const raw = await run({
            command: hardenedReviewCommand(command),
            prompt,
            cwd: project.path,
            absoluteCapMs: timeoutMs,
            ...(env !== undefined ? { env } : {}),
          })
          const proposal = sanitizeChecksProposal(extractProposalJson(raw))
          setState(
            project.id,
            proposal
              ? { status: 'ready', proposal }
              : { status: 'error', error: 'the agent did not return a usable checks proposal' },
          )
        } catch (err) {
          setState(project.id, { status: 'error', error: errorMessage(err) })
        }
      })()
      return { ok: true }
    },

    apply(project) {
      const state = states.get(project.id)
      if (state?.status !== 'ready') {
        return { ok: false, code: 409, error: 'no checks proposal to apply' }
      }
      try {
        write(project.path, proposalToChecksConfig(state.proposal))
      } catch (err) {
        // Writing is the only failure the user cannot fix from the UI: keep
        // the proposal so a retry (after fixing the file) still has it.
        return { ok: false, code: 500, error: errorMessage(err) }
      }
      setState(project.id, IDLE)
      return { ok: true }
    },
  }
}
