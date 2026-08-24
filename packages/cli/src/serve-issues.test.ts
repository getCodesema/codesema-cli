// GET /api/issues, kept in its own file rather than serve.test.ts: a distinct
// test seam (listIssues) and a distinct forge union (ForgeIssueReason, five
// members vs ForgeMrsResult's three) deserve their own fixtures rather than
// being folded into the existing MR suite.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ForgeIssuesResult } from './forge-issues.js'
import { addProject } from './projects.js'
import { createSession, startServer } from './serve.js'

type RawResponse = { status: number; body: string }

function rawRequest(
  port: number,
  path: string,
  opts: { method?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  })
}

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  runGit(dir, ['init', '-b', 'main'])
  return dir
}

const STUB_ISSUES: ForgeIssuesResult = {
  available: true,
  issues: [
    {
      number: 42,
      title: 'stubbed issue',
      body: 'a real body',
      state: 'open',
      labels: ['bug'],
      author: 'me',
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
      url: 'https://example.test/issues/42',
    },
  ],
  truncated: false,
}

describe('GET /api/issues, unscoped', () => {
  let repoDir: string
  let configDir: string
  let port: number
  let stop: () => Promise<void>
  let calls: string[]
  let nextResult: ForgeIssuesResult
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

  beforeAll(async () => {
    repoDir = makeRepo('codesema-issues-repo-')
    configDir = mkdtempSync(join(tmpdir(), 'codesema-issues-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    calls = []
    nextResult = STUB_ISSUES
    const started = await startServer(createSession(), {
      cwd: repoDir,
      port: 4960,
      listIssues: (cwd) => {
        calls.push(cwd)
        return Promise.resolve(nextResult)
      },
    })
    port = started.port
    stop = started.stop
  })

  afterAll(async () => {
    await stop()
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  test('returns the probe result verbatim and reads the launch cwd when ?project= is absent', async () => {
    calls.length = 0
    nextResult = STUB_ISSUES
    const res = await rawRequest(port, '/api/issues')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual(STUB_ISSUES)
    expect(calls).toEqual([repoDir])
  })

  test('an empty issue list is a success, not a degradation', async () => {
    nextResult = { available: true, issues: [], truncated: false }
    const res = await rawRequest(port, '/api/issues')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ available: true, issues: [], truncated: false })
  })

  test('every ForgeIssueReason motif reaches the client json unchanged, detail included when present', async () => {
    const cases: ForgeIssuesResult[] = [
      { available: false, reason: 'no-remote' },
      { available: false, reason: 'no-cli' },
      { available: false, reason: 'cli-error', detail: 'gh: timed out after 8s' },
      { available: false, reason: 'invalid-input', detail: 'invalid issue number: -1' },
      { available: false, reason: 'unsupported', detail: 'glab: hierarchyWidget not on schema' },
    ]
    for (const result of cases) {
      nextResult = result
      const res = await rawRequest(port, '/api/issues')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual(result)
    }
  })

  test('rejects a non-GET method', async () => {
    const res = await rawRequest(port, '/api/issues', { method: 'POST' })
    expect(res.status).toBe(405)
  })
})

describe('GET /api/issues, project-scoped', () => {
  let repoA: string
  let repoB: string
  let projectBId: string
  let projectBPath: string
  let configDir: string
  let port: number
  let stop: () => Promise<void>
  let calls: string[]
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-issues-scoped-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    repoA = makeRepo('codesema-issues-scoped-a-')
    repoB = makeRepo('codesema-issues-scoped-b-')
    const addedB = addProject(repoB)
    if (!addedB.ok) {
      throw new Error('failed to register test repo')
    }
    projectBId = addedB.project.id
    projectBPath = addedB.project.path
    calls = []
    const started = await startServer(createSession(), {
      cwd: repoA,
      port: 4961,
      listIssues: (cwd) => {
        calls.push(cwd)
        return Promise.resolve(STUB_ISSUES)
      },
    })
    port = started.port
    stop = started.stop
  })

  afterAll(async () => {
    await stop()
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  test('404s an unknown project', async () => {
    const res = await rawRequest(port, '/api/issues?project=deadbeef')
    expect(res.status).toBe(404)
  })

  test('runs the probe in the scoped project repo', async () => {
    calls.length = 0
    const res = await rawRequest(port, `/api/issues?project=${projectBId}`)
    expect(res.status).toBe(200)
    expect(calls).toEqual([projectBPath])
  })
})
