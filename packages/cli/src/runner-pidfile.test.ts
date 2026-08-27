import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  readRunnerPidfile,
  removeRunnerPidfile,
  runnerPidfilePath,
  writeRunnerPidfile,
} from './runner-pidfile.js'

// Repo-local, unlike workspace.lock: no CODESEMA_CONFIG_DIR redirection
// needed, just a throwaway cwd per test.

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'codesema-runner-pidfile-'))
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

function legacyPidfilePath(dir: string): string {
  return join(dir, '.codesema', 'brain.pid')
}

describe('runnerPidfilePath', () => {
  test('is repo-local, under .codesema', () => {
    expect(runnerPidfilePath(cwd)).toBe(join(cwd, '.codesema', 'runner.pid'))
  })
})

describe('readRunnerPidfile / writeRunnerPidfile', () => {
  test('absent file reads as null', () => {
    expect(readRunnerPidfile(cwd)).toBeNull()
  })

  test('round-trips pid, port and an ISO started_at, creating .codesema/', () => {
    writeRunnerPidfile(cwd, 4242, 4400)
    const pidfile = readRunnerPidfile(cwd)
    if (!pidfile) {
      throw new Error('expected a pidfile')
    }
    expect(pidfile.pid).toBe(4242)
    expect(pidfile.port).toBe(4400)
    expect(new Date(pidfile.started_at).toISOString()).toBe(pidfile.started_at)
  })

  test('a second write overwrites the first in place', () => {
    writeRunnerPidfile(cwd, 1, 4400)
    writeRunnerPidfile(cwd, 2, 4401)
    expect(readRunnerPidfile(cwd)).toMatchObject({ pid: 2, port: 4401 })
  })

  test('a corrupt or half-written file reads as null, never throws', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(runnerPidfilePath(cwd), '{"pid": 12')
    expect(readRunnerPidfile(cwd)).toBeNull()
  })

  test('non-integer pid/port or a non-string started_at all read as null', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(
      runnerPidfilePath(cwd),
      JSON.stringify({ pid: 'x', port: 4400, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    expect(readRunnerPidfile(cwd)).toBeNull()
    writeFileSync(
      runnerPidfilePath(cwd),
      JSON.stringify({ pid: 1, port: 4400.5, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    expect(readRunnerPidfile(cwd)).toBeNull()
    writeFileSync(runnerPidfilePath(cwd), JSON.stringify({ pid: 1, port: 4400, started_at: 123 }))
    expect(readRunnerPidfile(cwd)).toBeNull()
  })
})

describe('removeRunnerPidfile', () => {
  test('removes our own pidfile by default (process.pid)', () => {
    writeRunnerPidfile(cwd, process.pid, 4400)
    removeRunnerPidfile(cwd)
    expect(existsSync(runnerPidfilePath(cwd))).toBe(false)
  })

  test('never removes a pidfile naming a DIFFERENT pid than the default (process.pid)', () => {
    writeRunnerPidfile(cwd, deadPid(), 4400)
    removeRunnerPidfile(cwd)
    expect(existsSync(runnerPidfilePath(cwd))).toBe(true)
  })

  test('removes a foreign pid when it is passed explicitly (runnerStop/runnerStatus cleanup)', () => {
    const pid = deadPid()
    writeRunnerPidfile(cwd, pid, 4400)
    removeRunnerPidfile(cwd, pid)
    expect(existsSync(runnerPidfilePath(cwd))).toBe(false)
  })

  test('does not remove when the explicit pid no longer matches the file (raced by a fresh write)', () => {
    const stale = deadPid()
    writeRunnerPidfile(cwd, stale, 4400)
    writeRunnerPidfile(cwd, process.pid, 4401) // a new daemon boot took over the file
    removeRunnerPidfile(cwd, stale)
    expect(readRunnerPidfile(cwd)).toMatchObject({ pid: process.pid, port: 4401 })
  })

  test('is a no-op, never throws, when there is nothing to remove', () => {
    expect(() => removeRunnerPidfile(cwd)).not.toThrow()
    expect(existsSync(runnerPidfilePath(cwd))).toBe(false)
  })
})

describe('legacy brain.pid migration', () => {
  test('a legacy brain.pid is renamed to runner.pid on first read, and reads back correctly', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(
      legacyPidfilePath(cwd),
      JSON.stringify({ pid: 777, port: 4402, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    expect(readRunnerPidfile(cwd)).toMatchObject({ pid: 777, port: 4402 })
    expect(existsSync(legacyPidfilePath(cwd))).toBe(false)
    expect(existsSync(runnerPidfilePath(cwd))).toBe(true)
  })

  test('a legacy brain.pid is also migrated on first write, not just on read', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(
      legacyPidfilePath(cwd),
      JSON.stringify({ pid: 777, port: 4402, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    writeRunnerPidfile(cwd, 888, 4403)
    expect(existsSync(legacyPidfilePath(cwd))).toBe(false)
    expect(readRunnerPidfile(cwd)).toMatchObject({ pid: 888, port: 4403 })
  })

  test('runner.pid wins when both exist, and the legacy file is left untouched', () => {
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(
      legacyPidfilePath(cwd),
      JSON.stringify({ pid: 111, port: 4404, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    writeFileSync(
      runnerPidfilePath(cwd),
      JSON.stringify({ pid: 222, port: 4405, started_at: '2026-01-01T00:00:00.000Z' }),
    )
    expect(readRunnerPidfile(cwd)).toMatchObject({ pid: 222, port: 4405 })
    expect(existsSync(legacyPidfilePath(cwd))).toBe(true)
  })

  test('with neither file present, reading is still a plain null, no file created', () => {
    expect(readRunnerPidfile(cwd)).toBeNull()
    expect(existsSync(legacyPidfilePath(cwd))).toBe(false)
    expect(existsSync(runnerPidfilePath(cwd))).toBe(false)
  })
})
