import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addProject,
  discoverProjects,
  getProject,
  isProjectId,
  listProjects,
  projectIdFor,
  projectsPath,
  removeProject,
} from './projects.js'

// The registry is global state: redirected to a fresh tmpdir per test via
// CODESEMA_CONFIG_DIR so tests never touch the real ~/.config/codesema.

let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
const cleanups: string[] = []

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codesema-projects-'))
  cleanups.push(configDir)
  process.env.CODESEMA_CONFIG_DIR = configDir
})

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (previousConfigDir === undefined) {
    delete process.env.CODESEMA_CONFIG_DIR
  } else {
    process.env.CODESEMA_CONFIG_DIR = previousConfigDir
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-projects-repo-'))
  cleanups.push(dir)
  return dir
}

function makeRepo(): string {
  const repo = makeDir()
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  return repo
}

describe('isProjectId', () => {
  test('accepts exactly 8 lowercase hex chars', () => {
    expect(isProjectId('a1b2c3d4')).toBe(true)
    expect(isProjectId('A1B2C3D4')).toBe(false)
    expect(isProjectId('a1b2c3d')).toBe(false)
    expect(isProjectId('a1b2c3d4e')).toBe(false)
    expect(isProjectId('../../up')).toBe(false)
    expect(isProjectId('')).toBe(false)
    expect(isProjectId(42)).toBe(false)
  })
})

describe('addProject', () => {
  test('registers a git root: stable 8-hex id, basename name, ISO added_at', () => {
    const repo = makeRepo()
    const added = addProject(repo)
    expect(added.ok).toBe(true)
    if (!added.ok) {
      return
    }
    expect(added.project.id).toMatch(/^[0-9a-f]{8}$/)
    expect(added.project.name).toBe(basename(added.project.path))
    expect(added.project.path.endsWith(basename(repo))).toBe(true)
    expect(Number.isNaN(Date.parse(added.project.added_at))).toBe(false)
    expect(listProjects()).toEqual([added.project])
  })

  test('refuses a directory that is not a git repo', () => {
    const dir = makeDir()
    const added = addProject(dir)
    expect(added.ok).toBe(false)
    expect(listProjects()).toEqual([])
  })

  test('refuses a SUBDIRECTORY of a repo: only the git root registers', () => {
    const repo = makeRepo()
    const sub = join(repo, 'packages', 'cli')
    mkdirSync(sub, { recursive: true })
    const added = addProject(sub)
    expect(added.ok).toBe(false)
    if (added.ok) {
      return
    }
    expect(added.error).toContain(sub)
    expect(listProjects()).toEqual([])
  })

  test('refuses a path that does not exist', () => {
    expect(addProject(join(makeDir(), 'nope')).ok).toBe(false)
  })

  test('idempotent by path: re-adding returns the existing entry untouched', () => {
    const repo = makeRepo()
    const first = addProject(repo)
    const again = addProject(repo)
    expect(again).toEqual(first)
    expect(listProjects()).toHaveLength(1)
  })

  test('the id derives from the canonical path: stable across registry rewrites', () => {
    const repo = makeRepo()
    const added = addProject(repo)
    if (!added.ok) {
      throw new Error('add failed')
    }
    const other = addProject(makeRepo())
    expect(other.ok).toBe(true)
    // Wipe and re-add: the same path yields the same id.
    rmSync(projectsPath())
    const readded = addProject(repo)
    if (!readded.ok) {
      throw new Error('re-add failed')
    }
    expect(readded.project.id).toBe(added.project.id)
    expect(readded.project.id).toBe(projectIdFor(added.project.path))
  })

  test('two different repos get different ids, in registration order', () => {
    const a = addProject(makeRepo())
    const b = addProject(makeRepo())
    if (!a.ok || !b.ok) {
      throw new Error('add failed')
    }
    expect(a.project.id).not.toBe(b.project.id)
    expect(listProjects().map((p) => p.id)).toEqual([a.project.id, b.project.id])
  })

  test('atomic write: no tmp file left behind, file is complete JSON', () => {
    addProject(makeRepo())
    expect(readdirSync(configDir)).not.toContain('projects.json.tmp')
    const parsed = JSON.parse(readFileSync(projectsPath(), 'utf8')) as { projects: unknown[] }
    expect(parsed.projects).toHaveLength(1)
  })
})

describe('listProjects / getProject', () => {
  test('no registry yet: empty list, unknown ids are null', () => {
    expect(listProjects()).toEqual([])
    expect(getProject('a1b2c3d4')).toBeNull()
    expect(getProject('../../up')).toBeNull()
  })

  test('a corrupt registry degrades to empty, never a crash', () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(projectsPath(), '{ not json')
    expect(listProjects()).toEqual([])
    // And the next add starts a fresh registry over the corpse.
    const added = addProject(makeRepo())
    expect(added.ok).toBe(true)
    expect(listProjects()).toHaveLength(1)
  })

  test('mangled entries are skipped, valid ones survive, names are re-derived', () => {
    const repo = makeRepo()
    const added = addProject(repo)
    if (!added.ok) {
      throw new Error('add failed')
    }
    const doctored = {
      projects: [
        'junk',
        { id: 'not-hex!', path: '/somewhere' },
        { id: added.project.id, path: added.project.path, name: 'LIES', added_at: 42 },
        null,
      ],
    }
    writeFileSync(projectsPath(), JSON.stringify(doctored))
    const listed = listProjects()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(added.project.id)
    // The name is derived from the path, never trusted from disk.
    expect(listed[0]?.name).toBe(basename(added.project.path))
    expect(typeof listed[0]?.added_at).toBe('string')
    expect(getProject(added.project.id)?.path).toBe(added.project.path)
  })
})

describe('removeProject', () => {
  test('unregisters only the targeted entry; the repo on disk is untouched', () => {
    const repoA = makeRepo()
    const a = addProject(repoA)
    const b = addProject(makeRepo())
    if (!a.ok || !b.ok) {
      throw new Error('add failed')
    }
    expect(removeProject(a.project.id)).toBe(true)
    expect(listProjects().map((p) => p.id)).toEqual([b.project.id])
    // The repo itself still exists: removal is registry-only.
    expect(readdirSync(repoA)).toContain('.git')
  })

  test('unknown id: false, registry untouched', () => {
    const added = addProject(makeRepo())
    expect(added.ok).toBe(true)
    expect(removeProject('ffffffff')).toBe(false)
    expect(listProjects()).toHaveLength(1)
  })
})

describe('discoverProjects', () => {
  test('launch dir is itself a repo root: exactly that one candidate', () => {
    const repo = makeRepo()
    const found = discoverProjects(repo)
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe(basename(realpathSync(repo)))
    expect(found[0]?.registered).toBe(false)
  })

  test('non-repo dir: direct git children only, sorted by name, non-repos skipped', () => {
    const base = makeDir()
    for (const name of ['beta', 'alpha']) {
      const child = join(base, name)
      mkdirSync(child)
      execFileSync('git', ['init', '-b', 'main'], { cwd: child, stdio: 'ignore' })
    }
    mkdirSync(join(base, 'not-a-repo'))
    // Nested one level deeper: out of scope by design (one level, no recursion).
    const deep = join(base, 'not-a-repo', 'deep-repo')
    mkdirSync(deep)
    execFileSync('git', ['init', '-b', 'main'], { cwd: deep, stdio: 'ignore' })
    expect(discoverProjects(base).map((c) => c.name)).toEqual(['alpha', 'beta'])
  })

  test('hidden directories are skipped', () => {
    const base = makeDir()
    const hidden = join(base, '.secret')
    mkdirSync(hidden)
    execFileSync('git', ['init', '-b', 'main'], { cwd: hidden, stdio: 'ignore' })
    expect(discoverProjects(base)).toEqual([])
  })

  test('already registered repos are flagged, not silently dropped', () => {
    const base = makeDir()
    const child = join(base, 'known')
    mkdirSync(child)
    execFileSync('git', ['init', '-b', 'main'], { cwd: child, stdio: 'ignore' })
    const added = addProject(child)
    expect(added.ok).toBe(true)
    const found = discoverProjects(base)
    expect(found).toHaveLength(1)
    expect(found[0]?.registered).toBe(true)
  })

  test('unreadable base degrades to empty, never a crash', () => {
    expect(discoverProjects(join(tmpdir(), 'codesema-does-not-exist-xyz'))).toEqual([])
  })
})
