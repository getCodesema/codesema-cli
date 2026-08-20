import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acceptanceCriterionId,
  TICKET_BODY_HASH_TAG,
  TICKET_CRITERIA_MAX,
  TICKET_CRITERION_TEXT_MAX,
} from './contract.js'
import { addProject, type Project } from './projects.js'
import { createSession, startServer } from './serve.js'
import { applyTaskCriteria } from './task-criteria.js'
import type { TaskManager } from './task-server.js'
import { createTask, loadTask, readTaskEvents, saveTask } from './tasks-store.js'

let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
const cleanups: string[] = []

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codesema-task-criteria-cfg-'))
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

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-criteria-'))
  cleanups.push(repo)
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

function seedTask(cwd: string) {
  return createTask(cwd, {
    title: 'seeded',
    prompt: 'do work',
    autoShip: false,
    base: '',
    branch: '',
    worktree: '',
  })
}

function register(repo: string): Project {
  const added = addProject(repo)
  if (!added.ok) {
    throw new Error(added.error)
  }
  return added.project
}

const VALID_LIST = [
  'WHEN the user submits a valid payload THE SYSTEM SHALL persist the rate limit',
  'WHEN the bucket is empty THE SYSTEM SHALL reject the request',
  'WHEN the window elapses THE SYSTEM SHALL refill the bucket',
]

function earsList(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `WHEN input ${i} arrives THE SYSTEM SHALL handle it`,
  )
}

function criterionAtBound(): string {
  const prefix = 'WHEN '
  const suffix = ' THE SYSTEM SHALL y'
  const fill = TICKET_CRITERION_TEXT_MAX - prefix.length - suffix.length
  return `${prefix}${'x'.repeat(fill)}${suffix}`
}

describe('applyTaskCriteria', () => {
  test('a valid EARS list is persisted atomically and journaled', () => {
    const repo = makeRepo()
    const task = seedTask(repo)
    const result = applyTaskCriteria(repo, task.id, { criteria: VALID_LIST })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.criteria).toHaveLength(3)
    for (const text of VALID_LIST) {
      expect(
        result.criteria.some((c) => c.text === text && c.id === acceptanceCriterionId(text)),
      ).toBe(true)
    }
    const reloaded = loadTask(repo, task.id)
    expect(reloaded?.criteria).toEqual(result.criteria)
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8'),
    ) as { criteria?: unknown }
    expect(onDisk.criteria).toEqual(result.criteria)
    const events = readTaskEvents(repo, task.id)
    const validated = events.find((e) => e.type === 'criteria' && e.data.name === 'validated')
    expect(validated).toBeDefined()
    expect(validated?.data.count).toBe(3)
    expect(typeof validated?.data.message).toBe('string')
    expect(String(validated?.data.message).length).toBeGreaterThan(0)
  })

  test('an empty list is refused and the record is unchanged', () => {
    const repo = makeRepo()
    const task = seedTask(repo)
    const before = readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8')
    const result = applyTaskCriteria(repo, task.id, { criteria: [] })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.code).toBe(400)
    expect(result.error.toLowerCase()).toContain('empty')
    expect(readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8')).toBe(
      before,
    )
    expect(loadTask(repo, task.id)?.criteria).toBeUndefined()
    expect(readTaskEvents(repo, task.id).some((e) => e.type === 'criteria')).toBe(false)
  })

  test('unknown task is 404 and writes nothing', () => {
    const repo = makeRepo()
    const result = applyTaskCriteria(repo, 'aaaaaaaaaaaa', { criteria: VALID_LIST })
    expect(result).toEqual({ ok: false, code: 404, error: 'unknown task' })
  })

  test('number bound: TICKET_CRITERIA_MAX is accepted, one more is refused', () => {
    const repo = makeRepo()
    const atLimit = seedTask(repo)
    const over = seedTask(repo)
    expect(
      applyTaskCriteria(repo, atLimit.id, { criteria: earsList(TICKET_CRITERIA_MAX) }).ok,
    ).toBe(true)
    expect(loadTask(repo, atLimit.id)?.criteria).toHaveLength(TICKET_CRITERIA_MAX)
    const refused = applyTaskCriteria(repo, over.id, {
      criteria: earsList(TICKET_CRITERIA_MAX + 1),
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      return
    }
    expect(refused.code).toBe(400)
    expect(refused.error).toContain('criteria_too_many')
    expect(loadTask(repo, over.id)?.criteria).toBeUndefined()
  })

  test('length bound: TICKET_CRITERION_TEXT_MAX is accepted, one more is refused', () => {
    const repo = makeRepo()
    const atLimit = seedTask(repo)
    const over = seedTask(repo)
    const exact = criterionAtBound()
    expect(exact.length).toBe(TICKET_CRITERION_TEXT_MAX)
    const okList = [exact, VALID_LIST[1]!, VALID_LIST[2]!]
    expect(applyTaskCriteria(repo, atLimit.id, { criteria: okList }).ok).toBe(true)
    const tooLong = `${exact}x`
    const refused = applyTaskCriteria(repo, over.id, {
      criteria: [tooLong, VALID_LIST[1]!, VALID_LIST[2]!],
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      return
    }
    expect(refused.code).toBe(400)
    expect(refused.error).toContain('criterion_too_long')
    expect(loadTask(repo, over.id)?.criteria).toBeUndefined()
  })

  test('non-EARS criteria are refused with the lint reason, record unchanged', () => {
    const repo = makeRepo()
    const task = seedTask(repo)
    const before = readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8')
    const refused = applyTaskCriteria(repo, task.id, {
      criteria: [
        'the system should persist',
        'the system should reject',
        'the system should refill',
      ],
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      return
    }
    expect(refused.code).toBe(400)
    expect(refused.error).toContain('criterion_not_ears')
    expect(readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8')).toBe(
      before,
    )
  })

  test('a missing criteria key is refused', () => {
    const repo = makeRepo()
    const task = seedTask(repo)
    const refused = applyTaskCriteria(repo, task.id, { other: true })
    expect(refused).toEqual({
      ok: false,
      code: 400,
      error: 'the request must carry a criteria list',
    })
  })

  test('applying does not overwrite an issue_snapshot', () => {
    const repo = makeRepo()
    const task = seedTask(repo)
    const snapshotCriteria = [
      {
        id: acceptanceCriterionId(VALID_LIST[0]!),
        text: VALID_LIST[0]!,
      },
    ]
    task.issue_snapshot = {
      body_hash: `${TICKET_BODY_HASH_TAG}:${'a'.repeat(64)}`,
      criteria: snapshotCriteria,
      taken_at: '2026-08-14T09:00:00.000Z',
    }
    saveTask(repo, task)
    const result = applyTaskCriteria(repo, task.id, { criteria: VALID_LIST })
    expect(result.ok).toBe(true)
    const reloaded = loadTask(repo, task.id)
    expect(reloaded?.issue_snapshot?.criteria).toEqual(snapshotCriteria)
    expect(reloaded?.criteria).toHaveLength(3)
  })
})

function unusedTaskManager(): TaskManager {
  const refused = { ok: false as const, code: 501, error: 'unused' }
  return {
    list: () => null,
    listAll: () => [],
    get: () => null,
    create: async () => refused,
    reply: () => refused,
    resume: () => refused,
    interrupt: () => refused,
    ship: async () => refused,
    abandon: async () => refused,
    checks: () => refused,
    getChecks: () => null,
    getReview: () => null,
    checksSetup: () => refused,
    checksSetupStatus: () => null,
    workspaceInfo: () => ({
      isolation_available: false,
      isolation_default: 'policy',
      isolation_reason: 'unused',
      isolation_configured: 'auto',
      agent: 'claude -p',
    }),
    checksApply: () => refused,
    startPending: async () => [],
    sweepOrphanedVolumes: async () => {},
    applyRetention: async () => {},
    shutdown: async () => {},
    subscribe: () => () => {},
    defaultCommand: () => 'claude -p',
    setDefaultCommand: () => {},
  }
}

type RawResponse = { status: number; body: string }

function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) {
      req.write(opts.body)
    }
    req.end()
  })
}

async function tasksToken(port: number): Promise<string> {
  const html = await rawRequest(port, '/')
  const match = /__CODESEMA_TASKS_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('POST /api/tasks/:id/criteria', () => {
  test('CSRF: missing or invalid token is 403 and persists nothing', async () => {
    const project = register(makeRepo())
    const task = seedTask(project.path)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5321,
      taskManager: unusedTaskManager(),
    })
    try {
      const token = await tasksToken(started.port)
      const path = `/api/tasks/${task.id}/criteria?project=${project.id}`
      const noToken = await rawRequest(started.port, path, {
        method: 'POST',
        body: JSON.stringify({ criteria: VALID_LIST }),
      })
      expect(noToken.status).toBe(403)
      const badToken = await rawRequest(started.port, path, {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': 'wrong' },
        body: JSON.stringify({ criteria: VALID_LIST }),
      })
      expect(badToken.status).toBe(403)
      expect(loadTask(project.path, task.id)?.criteria).toBeUndefined()
      const ok = await rawRequest(started.port, path, {
        method: 'POST',
        headers: {
          'x-codesema-tasks-token': token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ criteria: VALID_LIST }),
      })
      expect(ok.status).toBe(200)
      expect(loadTask(project.path, task.id)?.criteria).toHaveLength(3)
    } finally {
      await started.stop()
    }
  })

  test('unknown task is 404', async () => {
    const project = register(makeRepo())
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5341,
      taskManager: unusedTaskManager(),
    })
    try {
      const token = await tasksToken(started.port)
      const res = await rawRequest(
        started.port,
        `/api/tasks/aaaaaaaaaaaa/criteria?project=${project.id}`,
        {
          method: 'POST',
          headers: {
            'x-codesema-tasks-token': token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ criteria: VALID_LIST }),
        },
      )
      expect(res.status).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'unknown task' })
    } finally {
      await started.stop()
    }
  })

  test('empty list is refused over HTTP with its reason', async () => {
    const project = register(makeRepo())
    const task = seedTask(project.path)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5361,
      taskManager: unusedTaskManager(),
    })
    try {
      const token = await tasksToken(started.port)
      const res = await rawRequest(
        started.port,
        `/api/tasks/${task.id}/criteria?project=${project.id}`,
        {
          method: 'POST',
          headers: {
            'x-codesema-tasks-token': token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ criteria: [] }),
        },
      )
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).error).toContain('empty')
      expect(loadTask(project.path, task.id)?.criteria).toBeUndefined()
    } finally {
      await started.stop()
    }
  })

  test('a body over the task payload ceiling is rejected like other mutations', async () => {
    const project = register(makeRepo())
    const task = seedTask(project.path)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5381,
      taskManager: unusedTaskManager(),
    })
    try {
      const token = await tasksToken(started.port)
      const res = await rawRequest(
        started.port,
        `/api/tasks/${task.id}/criteria?project=${project.id}`,
        {
          method: 'POST',
          headers: {
            'x-codesema-tasks-token': token,
            'content-type': 'application/json',
          },
          body: 'x'.repeat(64 * 1024 + 1),
        },
      )
      expect(res.status).toBe(400)
      expect(loadTask(project.path, task.id)?.criteria).toBeUndefined()
    } finally {
      await started.stop()
    }
  })

  test('lint-ok EARS list is accepted over HTTP; lint-ko is refused with its reason', async () => {
    const project = register(makeRepo())
    const okTask = seedTask(project.path)
    const koTask = seedTask(project.path)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5401,
      taskManager: unusedTaskManager(),
    })
    try {
      const token = await tasksToken(started.port)
      const headers = {
        'x-codesema-tasks-token': token,
        'content-type': 'application/json',
      }
      const ok = await rawRequest(
        started.port,
        `/api/tasks/${okTask.id}/criteria?project=${project.id}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ criteria: VALID_LIST }),
        },
      )
      expect(ok.status).toBe(200)
      const payload = JSON.parse(ok.body) as {
        ok: boolean
        criteria: { id: string; text: string }[]
      }
      expect(payload.ok).toBe(true)
      expect(payload.criteria).toHaveLength(3)
      expect(loadTask(project.path, okTask.id)?.criteria).toHaveLength(3)

      const ko = await rawRequest(
        started.port,
        `/api/tasks/${koTask.id}/criteria?project=${project.id}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            criteria: ['not ears at all', 'still not', 'nope'],
          }),
        },
      )
      expect(ko.status).toBe(400)
      expect(JSON.parse(ko.body).error).toContain('criterion_not_ears')
      expect(loadTask(project.path, koTask.id)?.criteria).toBeUndefined()
    } finally {
      await started.stop()
    }
  })
})
