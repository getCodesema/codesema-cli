import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  brainPidfilePath,
  readBrainPidfile,
  removeBrainPidfile,
  writeBrainPidfile,
} from './brain-pidfile.js'

// Repo-local, unlike workspace.lock: no CODESEMA_CONFIG_DIR redirection
// needed, just a throwaway cwd per test.

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'codesema-brain-pidfile-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

/** A pid that is certainly dead: a child that already ran to completion. */
function deadPid(): number {
  const child = spawnSync('true')
  expect(child.pid).toBeGreaterThan(0)
  return child.pid
}

describe('brainPidfilePath', () => {
  test('is repo-local, under .codesema', () => {
    expect(brainPidfilePath(cwd)).toBe(join(cwd, '.codesema', 'brain.pid'))
  })
})

describe('readBrainPidfile / writeBrainPidfile', () => {
  test('absent file reads as null', () => {
    expect(readBrainPidfile(cwd)).toBeNull()
  })

  test('round-trips pid, port and an ISO started_at, creating .codesema/', () => {
    writeBrainPidfile(cwd, 4242, 4400)
    const pidfile = readBrainPidfile(cwd)
    if (!pidfile) {
      throw new Error('expected a pidfile')
    }
    expect(pidfile.pid).toBe(4242)
    expect(pidfile.port).toBe(4400)
    expect(new Date(pidfile.started_at).toISOString()).toBe(pidfile.started_at)
  })

  test('a second write overwrites the first in place', () => {
    writeBrainPidfile(cwd, 1, 4400)
    writeBrainPidfile(cwd, 2, 4401)
    expect(readBrainPidfile(cwd)).toMatchObject({ pid: 2, port: 4401 })
  })

  test('a corrupt or half-written file reads as null, never throws', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(brainPidfilePath(cwd), '{"pid": 12')
    expect(readBrainPidfile(cwd)).toBeNull()
  })

  test('non-integer pid/port or a non-string started_at all read as null', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(
      brainPidfilePath(cwd),
      JSON.stringify({ pid: 'x', port: 4400, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    expect(readBrainPidfile(cwd)).toBeNull()
    writeFileSync(
      brainPidfilePath(cwd),
      JSON.stringify({ pid: 1, port: 4400.5, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    expect(readBrainPidfile(cwd)).toBeNull()
    writeFileSync(brainPidfilePath(cwd), JSON.stringify({ pid: 1, port: 4400, started_at: 123 }))
    expect(readBrainPidfile(cwd)).toBeNull()
  })
})

describe('removeBrainPidfile', () => {
  test('removes our own pidfile by default (process.pid)', () => {
    writeBrainPidfile(cwd, process.pid, 4400)
    removeBrainPidfile(cwd)
    expect(existsSync(brainPidfilePath(cwd))).toBe(false)
  })

  test('never removes a pidfile naming a DIFFERENT pid than the default (process.pid)', () => {
    writeBrainPidfile(cwd, deadPid(), 4400)
    removeBrainPidfile(cwd)
    expect(existsSync(brainPidfilePath(cwd))).toBe(true)
  })

  test('removes a foreign pid when it is passed explicitly (brainStop/brainStatus cleanup)', () => {
    const pid = deadPid()
    writeBrainPidfile(cwd, pid, 4400)
    removeBrainPidfile(cwd, pid)
    expect(existsSync(brainPidfilePath(cwd))).toBe(false)
  })

  test('does not remove when the explicit pid no longer matches the file (raced by a fresh write)', () => {
    const stale = deadPid()
    writeBrainPidfile(cwd, stale, 4400)
    writeBrainPidfile(cwd, process.pid, 4401) // a new daemon boot took over the file
    removeBrainPidfile(cwd, stale)
    expect(readBrainPidfile(cwd)).toMatchObject({ pid: process.pid, port: 4401 })
  })

  test('is a no-op, never throws, when there is nothing to remove', () => {
    expect(() => removeBrainPidfile(cwd)).not.toThrow()
    expect(existsSync(brainPidfilePath(cwd))).toBe(false)
  })
})
