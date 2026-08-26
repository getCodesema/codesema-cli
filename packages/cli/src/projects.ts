// Global project registry for the multi-project workspace: one workspace
// process drives several repos, each registered here as a Project. The
// registry lives in <globalConfigDir()>/projects.json (never inside a repo);
// the repos themselves stay the source of truth for their tasks — this file
// only maps stable ids to git roots. Reads are corruption-tolerant like
// parseConfig (a broken file is an empty registry, never a crash) and writes
// are atomic (tmp + rename).
//
// One project is not in the file and never will be: the scratch project, the
// workspace's own directory, synthesized on every read. It is where a
// conversation lives while it has no repository, so that starting one costs
// the user's repositories nothing.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import { globalConfigDir } from './config.js'
import { tryGit } from './git.js'
import { t } from './i18n.js'

export type Project = {
  /** 8 lowercase hex chars, stable: derived from the canonical path. */
  id: string
  /** Absolute git repository root, or the scratch directory when kind is 'scratch'. */
  path: string
  /** Display name: basename of the path. */
  name: string
  /**
   * 'scratch' names the one project that is NOT a git repository: the
   * workspace's own directory, where a conversation lives before it is given
   * any repo. Callers that reach for git (worktrees, branches, ship, MR) must
   * check this rather than assume `path` is a repo root.
   */
  kind: 'repo' | 'scratch'
  added_at: string
}

/** The id is used in URLs and joined into lookups: nothing else is usable. */
const PROJECT_ID_RE = /^[0-9a-f]{8}$/

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_RE.test(value)
}

export function projectsPath(): string {
  return join(globalConfigDir(), 'projects.json')
}

/**
 * Stable id: first 8 hex chars of sha256(canonical path). Deterministic so a
 * project keeps its id across registry rewrites, re-adds, and even a deleted
 * then recreated registry file.
 */
export function projectIdFor(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 8)
}

function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const p = raw as Record<string, unknown>
  const path = typeof p.path === 'string' ? p.path : ''
  if (!path || !isProjectId(p.id)) {
    return null
  }
  return {
    id: p.id,
    path,
    // The name is derived, never trusted from disk: the basename cannot drift
    // from the path it names.
    name: basename(path),
    // addProject refuses anything but a git root, so every persisted entry is
    // one. The scratch project is synthesized, never read back from here.
    kind: 'repo',
    added_at: typeof p.added_at === 'string' && p.added_at ? p.added_at : new Date().toISOString(),
  }
}

/**
 * The workspace's own directory: where a conversation that has been given no
 * repository does its work. Deliberately outside every repo, so a discussion
 * costs the user's repositories nothing — no branch, no worktree, no
 * `.codesema/` in a tree they did not ask us to touch.
 */
export function scratchDir(): string {
  return join(globalConfigDir(), 'scratch')
}

/**
 * Synthetic, always present, never persisted in projects.json: it is a
 * property of the workspace, not something the user registered. Its id is
 * derived like any other so URLs, SSE frames and task lookups treat it as an
 * ordinary project.
 */
export function scratchProject(): Project {
  const path = scratchDir()
  return {
    id: projectIdFor(path),
    path,
    name: 'scratch',
    kind: 'scratch',
    added_at: new Date(0).toISOString(),
  }
}

export function isScratchProjectId(id: string): boolean {
  return id === projectIdFor(scratchDir())
}

/** listProjects, plus whether the read was COMPLETE (see listProjectsDetailed). */
export type ProjectRegistry = { projects: Project[]; complete: boolean }

/**
 * Same registry as `listProjects`, but says whether the read was COMPLETE.
 * `complete: false` on a `projects.json` that exists but could not be parsed
 * (corrupt JSON, an I/O error) or on ANY entry the sanitizer had to drop (a
 * hand-edited id, a path missing, a newer schema this build cannot read) —
 * as opposed to a registry that was simply never created (ENOENT), which is
 * an honestly EMPTY, complete registry.
 *
 * Most callers only ever want the tolerant `Project[]` (a broken registry
 * must never crash the workspace) and `listProjects` keeps giving them
 * exactly that. This exists for the rarer caller that would otherwise read
 * "no project claims this resource" from a registry it silently narrowed —
 * the T1.9 orphaned-volume sweep is the first one.
 */
export function listProjectsDetailed(): ProjectRegistry {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(projectsPath(), 'utf8'))
  } catch (err) {
    // A registry that was never created is an honest empty one; anything
    // else that kept this from being read (corrupt JSON, EACCES, EIO) is an
    // INCOMPLETE one — the two must never be conflated (see doctrine above).
    const complete = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { projects: [], complete }
  }
  const entries = Array.isArray((raw as { projects?: unknown } | null)?.projects)
    ? ((raw as { projects: unknown[] }).projects as unknown[])
    : []
  const projects: Project[] = []
  const seen = new Set<string>()
  let complete = true
  for (const entry of entries) {
    const project = sanitizeProject(entry)
    if (!project) {
      complete = false
      continue
    }
    if (!seen.has(project.id)) {
      seen.add(project.id)
      projects.push(project)
    }
  }
  return { projects, complete }
}

/**
 * All registered projects, in registration order. A missing, corrupt or
 * hand-mangled file degrades to an empty (or partial) registry — same
 * tolerance as parseConfig. Duplicate ids keep the first occurrence.
 */
export function listProjects(): Project[] {
  return listProjectsDetailed().projects
}

export function getProject(id: string): Project | null {
  if (!isProjectId(id)) {
    return null
  }
  if (isScratchProjectId(id)) {
    return scratchProject()
  }
  return listProjects().find((project) => project.id === id) ?? null
}

/**
 * What the workspace can actually run a conversation against: the scratch
 * project first, then everything the user registered. `listProjects` stays the
 * registry ALONE, so anything that writes projects.json keeps operating on the
 * file's own contents.
 */
export function listWorkspaceProjects(): Project[] {
  return [scratchProject(), ...listProjects()]
}

/** Atomic rewrite (shared tmp + rename): a crash mid-write leaves the previous registry intact. */
function saveProjects(projects: Project[]): void {
  writeJsonAtomic(projectsPath(), { projects })
}

export type AddProjectResult = { ok: true; project: Project } | { ok: false; error: string }

/**
 * Registers a git repository by its ROOT path. The path must name the
 * repository root itself (`git rev-parse --show-toplevel` resolving to the
 * same directory): a subdirectory or a non-repo is refused — registering a
 * subtree would split one repo into several phantom projects. Idempotent: the
 * canonical path always maps to the same 8-hex id, and re-adding returns the
 * existing entry untouched (added_at preserved).
 */
export function addProject(path: string): AddProjectResult {
  let canonical: string
  try {
    // realpath: '/tmp/repo' and '/private/tmp/repo' (symlinked tmp) are the
    // same project and must get the same id.
    canonical = realpathSync(resolve(path))
  } catch {
    return { ok: false, error: t('projects.notGitRoot', { path }) }
  }
  const toplevel = tryGit(['rev-parse', '--show-toplevel'], canonical)
  if (!toplevel || realpathSync(toplevel) !== canonical) {
    return { ok: false, error: t('projects.notGitRoot', { path }) }
  }
  const projects = listProjects()
  const id = projectIdFor(canonical)
  const existing = projects.find((project) => project.id === id)
  if (existing) {
    return { ok: true, project: existing }
  }
  const project: Project = {
    id,
    path: canonical,
    name: basename(canonical),
    kind: 'repo',
    added_at: new Date().toISOString(),
  }
  saveProjects([...projects, project])
  return { ok: true, project }
}

export type ProjectCandidate = {
  /** Absolute path of the detected git working tree. */
  path: string
  name: string
  /** Already in the registry: the UI shows it as added instead of offering it. */
  registered: boolean
}

/** Scanning every child of a huge directory (~/ by mistake) must stay cheap. */
const DISCOVER_MAX_CANDIDATES = 50

/**
 * Git repositories reachable from where the workspace was launched: the launch
 * directory itself when it is a repo root, otherwise its DIRECT children (one
 * level, no recursion — deeper nesting is what the manual path field is for).
 * Detection is a `.git` presence check (dir or file: linked worktrees and
 * submodules have a .git FILE), not a git spawn per child: a directory of a
 * hundred entries must not fork a hundred processes. Hidden directories are
 * skipped. Unreadable entries are ignored, never a crash.
 */
export function discoverProjects(cwd: string): ProjectCandidate[] {
  let base: string
  try {
    base = realpathSync(resolve(cwd))
  } catch {
    return []
  }
  const registered = new Set(listProjects().map((project) => project.id))
  const candidate = (path: string): ProjectCandidate => ({
    path,
    name: basename(path),
    registered: registered.has(projectIdFor(path)),
  })

  if (existsSync(join(base, '.git'))) {
    return [candidate(base)]
  }

  let entries: Dirent[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates: ProjectCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }
    const dir = join(base, entry.name)
    if (!existsSync(join(dir, '.git'))) {
      continue
    }
    try {
      candidates.push(candidate(realpathSync(dir)))
    } catch {
      // vanished between readdir and realpath: skip
    }
    if (candidates.length >= DISCOVER_MAX_CANDIDATES) {
      break
    }
  }
  return candidates.toSorted((a, b) => a.name.localeCompare(b.name))
}

/**
 * Unregisters a project. ONLY the registry entry goes away: the repo, its
 * .codesema/, its tasks and worktrees are never touched. False on unknown id.
 */
export function removeProject(id: string): boolean {
  const projects = listProjects()
  const remaining = projects.filter((project) => project.id !== id)
  if (remaining.length === projects.length) {
    return false
  }
  saveProjects(remaining)
  return true
}
