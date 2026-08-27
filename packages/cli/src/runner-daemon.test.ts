import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ArmTicket, ArmTicketRequest, TaskRecord } from './contract.js'
import type { Project } from './projects.js'
import { startRunnerDaemon } from './runner-daemon.js'
import type { TaskActionResult } from './task-runner.js'
import type { TaskCreateResult, TaskManager } from './task-server.js'

type Call = { url: string; init: RequestInit }

function fetchStub(status: number, body: unknown, calls: Call[]): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

function fetchOffline(): typeof fetch {
  return (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
}

function initRepo(cwd: string, remoteUrl?: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'chore: init',
    ],
    { cwd },
  )
  if (remoteUrl) {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd })
  }
}

function fakeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'task1',
    title: 't',
    status: 'running',
    base: 'main',
    branch: 'codesema/task-t',
    worktree: '',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: true,
    work_on: false,
    isolation: 'policy',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** `id`/`path` both set to `cwd`: unique per test (a fresh tmpdir), so no two tests can collide in task-queue.ts's module-level active-task map. */
function fakeManager(opts: {
  cwd: string
  records?: TaskRecord[]
  resumeCalls?: Array<{ projectId: string; id: string }>
  createResult?: TaskCreateResult
  createCalls?: { projectId: string; input: unknown }[]
  shipCalls?: Array<{ projectId: string; id: string }>
  shipResult?: TaskActionResult
  replyCalls?: Array<{ projectId: string; id: string; message: string }>
  replyResult?: TaskActionResult
  abandonCalls?: Array<{ projectId: string; id: string }>
  abandonResult?: TaskActionResult
}): TaskManager {
  const project: Project = {
    id: opts.cwd,
    path: opts.cwd,
    name: 'r',
    kind: 'repo',
    added_at: '2026-01-01T00:00:00.000Z',
  }
  const records = opts.records ?? []
  return {
    listAll: () => [{ project, records }],
    get: (projectId: string, id: string) => {
      const record = records.find((r) => r.id === id)
      return projectId === project.id && record ? { record, events: [] } : null
    },
    create: async (projectId: string, input: unknown) => {
      opts.createCalls?.push({ projectId, input })
      return opts.createResult ?? { ok: false, code: 500, error: 'not stubbed' }
    },
    resume: (projectId: string, id: string) => {
      opts.resumeCalls?.push({ projectId, id })
      return { ok: true }
    },
    ship: async (projectId: string, id: string) => {
      opts.shipCalls?.push({ projectId, id })
      return opts.shipResult ?? { ok: true }
    },
    reply: (projectId: string, id: string, message: string) => {
      opts.replyCalls?.push({ projectId, id, message })
      return opts.replyResult ?? { ok: true }
    },
    abandon: async (projectId: string, id: string) => {
      opts.abandonCalls?.push({ projectId, id })
      return opts.abandonResult ?? { ok: true }
    },
  } as unknown as TaskManager
}

const validTicket: ArmTicket = {
  id: 'tkt1',
  repo_remote_url: 'https://github.com/o/r.git',
  title: 'Add a thing',
  body: '**Context**\n\nx',
  status: 'published',
  depends_on: null,
  executed_by: null,
  lease_expires_at: null,
  issue: null,
  branch: null,
  mr_iid: null,
  mr_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function fastSleep(_ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 1)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Answers `order` on the FIRST heartbeat only, `null` on every one after
 * (the real hub purges an order the moment it hands it back, D19), and an
 * otherwise-empty tick everywhere else. `fastSleep` drives several
 * heartbeat-loop iterations within one `settle()` window, so a stub that
 * kept re-serving the same order would make a dispatch test see it applied
 * once per iteration instead of once.
 */
function fetchHeartbeatOrder(order: unknown, calls: Call[]): typeof fetch {
  let served = false
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init: init ?? {} })
    if (href.endsWith('/heartbeat')) {
      const body = served ? null : order
      served = true
      return new Response(
        JSON.stringify({ lease_expires_at: '2026-01-01T00:05:00.000Z', order: body }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ requests: [], tickets: [] }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('startRunnerDaemon', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-daemon-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-daemon-repo-'))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
  })

  test('not connected: logs once and makes no HTTP call', async () => {
    const calls: Call[] = []
    const lines: string[] = []
    const manager = fakeManager({ cwd })
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, {}, calls),
      logFn: (line) => lines.push(line),
    })
    await handle.stop()
    expect(calls.length).toBe(0)
    expect(lines.some((l) => l.includes('not connected'))).toBe(true)
  })

  test('no git origin remote: logs once and makes no HTTP call', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd)
    const calls: Call[] = []
    const lines: string[] = []
    const manager = fakeManager({ cwd })
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, {}, calls),
      logFn: (line) => lines.push(line),
    })
    await handle.stop()
    expect(calls.length).toBe(0)
    expect(lines.some((l) => l.includes('no git origin remote'))).toBe(true)
  })

  test('flushes the outbox on every tick', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(
      join(cwd, '.codesema', 'hub-outbox.jsonl'),
      `${JSON.stringify({
        kind: 'transition',
        key: 'k1',
        ticket_id: 'tkt1',
        transition: { type: 'merged', idempotency_key: 'k1', at: '2026-01-01T00:00:00.000Z' },
      })}\n`,
    )
    const calls: Call[] = []
    const manager = fakeManager({ cwd })
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [] }, calls),
      logFn: () => {},
    })
    await handle.stop()
    expect(
      calls.some((c) => c.url === 'https://hub.example/api/cli/tickets/tkt1/transitions'),
    ).toBe(true)
  })

  test('a non-terminal record blocks claiming, admitted or not', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const calls: Call[] = []
    const manager = fakeManager({
      cwd,
      records: [{ id: 'existing-task', status: 'waiting_for_you' } as TaskRecord],
    })
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [validTicket] }, calls),
      logFn: () => {},
    })
    await handle.stop()
    expect(calls.some((c) => c.url.includes('/api/cli/tickets?'))).toBe(false)
  })

  test('an interrupted hub-ticket task is resumed instead of blocking the loop', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const calls: Call[] = []
    const resumeCalls: Array<{ projectId: string; id: string }> = []
    const manager = fakeManager({
      cwd,
      resumeCalls,
      records: [
        {
          id: 'parked-task',
          status: 'interrupted',
          hub_ticket: { id: validTicket.id, title: validTicket.title },
        } as TaskRecord,
      ],
    })
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [validTicket] }, calls),
      logFn: () => {},
    })
    await handle.stop()
    expect(resumeCalls).toEqual([{ projectId: expect.any(String), id: 'parked-task' }])
    expect(calls.some((c) => c.url.includes('/claim'))).toBe(false)
  })

  test('a ticket that already has a local task is not claimed again', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const calls: Call[] = []
    const manager = fakeManager({
      cwd,
      records: [
        {
          id: 'shipped-task',
          status: 'shipped',
          hub_ticket: { id: validTicket.id, title: validTicket.title },
        } as TaskRecord,
      ],
    })
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [validTicket] }, calls),
      logFn: () => {},
    })
    await handle.stop()
    expect(calls.some((c) => c.url.includes('/tickets/') && c.url.includes('/claim'))).toBe(false)
  })

  test('no active task and a published ticket: claims it and starts a task on the same manager', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const createCalls: { projectId: string; input: unknown }[] = []
    const manager = fakeManager({
      cwd,
      createCalls,
      createResult: {
        ok: true,
        record: fakeRecord({ id: 'newtask', hub_ticket: { id: 'tkt1', title: 'Add a thing' } }),
      },
    })
    const calls: Call[] = []
    const lines: string[] = []
    const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      calls.push({ url: href, init: init ?? {} })
      if (href.includes('/ticket-requests')) {
        return new Response(JSON.stringify({ requests: [] }), { status: 200 })
      }
      if (href.includes('/tickets?')) {
        return new Response(JSON.stringify({ tickets: [validTicket] }), { status: 200 })
      }
      if (href.endsWith('/claim')) {
        return new Response(
          JSON.stringify({ ticket: validTicket, lease_expires_at: '2026-01-01T00:05:00.000Z' }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl,
      logFn: (line) => lines.push(line),
    })
    await handle.stop()
    expect(calls.some((c) => c.url === 'https://hub.example/api/cli/tickets/tkt1/claim')).toBe(true)
    expect(createCalls.length).toBe(1)
    expect(lines.some((l) => l.includes('started task newtask'))).toBe(true)
  })

  test('a queued ticket request is drafted and submitted through draftFn', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const request: ArmTicketRequest = {
      id: 'req1',
      repo_remote_url: 'https://github.com/o/r.git',
      prompt: 'add a thing',
      status: 'queued',
      source_issue: null,
      created_at: '2026-01-01T00:00:00.000Z',
    }
    const calls: Call[] = []
    const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      calls.push({ url: href, init: init ?? {} })
      if (href.includes('/ticket-requests') && href.endsWith('/claim')) {
        return new Response(JSON.stringify({ request }), { status: 200 })
      }
      if (href.includes('/ticket-requests?')) {
        return new Response(JSON.stringify({ requests: [request] }), { status: 200 })
      }
      if (href.includes('/tickets?')) {
        return new Response(JSON.stringify({ tickets: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    const draftCalls: { requestId: string; cwd: string }[] = []
    const manager = fakeManager({ cwd })
    const lines: string[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl,
      logFn: (line) => lines.push(line),
      draftFn: async (req, draftCwd) => {
        draftCalls.push({ requestId: req.id, cwd: draftCwd })
        return { ok: true, tickets: [validTicket] }
      },
    })
    await handle.stop()
    expect(draftCalls).toEqual([{ requestId: 'req1', cwd }])
    expect(lines.some((l) => l.includes('published 1 ticket(s) from request req1'))).toBe(true)
  })

  test('backs off after a network failure, not after a 4xx', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const manager = fakeManager({ cwd })

    const offlineDurations: number[] = []
    const offlineHandle = startRunnerDaemon({
      manager,
      cwd,
      intervalMs: 1000,
      fetchImpl: fetchOffline(),
      logFn: () => {},
      sleepFn: (ms) => {
        offlineDurations.push(ms)
        return Promise.resolve()
      },
    })
    await offlineHandle.stop()
    expect(offlineDurations.find((d) => d !== 45_000)).toBe(2000)

    const badRequestDurations: number[] = []
    const badRequestHandle = startRunnerDaemon({
      manager,
      cwd,
      intervalMs: 1000,
      fetchImpl: fetchStub(400, { error: 'bad request' }, []),
      logFn: () => {},
      sleepFn: (ms) => {
        badRequestDurations.push(ms)
        return Promise.resolve()
      },
    })
    await badRequestHandle.stop()
    expect(badRequestDurations.find((d) => d !== 45_000)).toBe(1000)
  })

  test('heartbeats the active hub-ticket task on its own schedule', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const { claimActive } = await import('./task-queue.js')
    claimActive(cwd, 'active1')
    const record = fakeRecord({ id: 'active1', hub_ticket: { id: 'tkt1', title: 'Add a thing' } })
    const manager = fakeManager({ cwd, records: [record] })
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [] }, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(calls.some((c) => c.url === 'https://hub.example/api/cli/tickets/tkt1/heartbeat')).toBe(
      true,
    )
  })

  test('heartbeats a waiting_for_you hub-ticket task even when the memory slot is free', async () => {
    // Regression: the memory slot (claimActive/activeTask) empties the moment
    // a turn's promise settles, so a task parked on waiting_for_you must be
    // found from the PERSISTED record, never from that slot.
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const manager = fakeManager({ cwd, records: [record] })
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [] }, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(calls.some((c) => c.url === 'https://hub.example/api/cli/tickets/tkt1/heartbeat')).toBe(
      true,
    )
  })

  test('the heartbeat carries the persisted status as local_status', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const manager = fakeManager({ cwd, records: [record] })
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchStub(200, { requests: [], tickets: [] }, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    const heartbeatCall = calls.find((c) => c.url.endsWith('/heartbeat'))
    expect(JSON.parse(String(heartbeatCall?.init.body))).toEqual({
      local_status: 'waiting_for_you',
    })
  })

  test('a ship order from the heartbeat response ships the task', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const shipCalls: Array<{ projectId: string; id: string }> = []
    const manager = fakeManager({ cwd, records: [record], shipCalls })
    const order = { action: 'ship', instruction: null, issued_at: '2026-01-01T00:00:00.000Z' }
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchHeartbeatOrder(order, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(shipCalls).toEqual([{ projectId: expect.any(String), id: 'active1' }])
  })

  test('a reply order from the heartbeat response replies with the instruction', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const replyCalls: Array<{ projectId: string; id: string; message: string }> = []
    const manager = fakeManager({ cwd, records: [record], replyCalls })
    const order = {
      action: 'reply',
      instruction: 'fix the flaky test',
      issued_at: '2026-01-01T00:00:00.000Z',
    }
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchHeartbeatOrder(order, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(replyCalls).toEqual([
      { projectId: expect.any(String), id: 'active1', message: 'fix the flaky test' },
    ])
  })

  test('an abandon order from the heartbeat response abandons the task', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const abandonCalls: Array<{ projectId: string; id: string }> = []
    const manager = fakeManager({ cwd, records: [record], abandonCalls })
    const order = { action: 'abandon', instruction: null, issued_at: '2026-01-01T00:00:00.000Z' }
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchHeartbeatOrder(order, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(abandonCalls).toEqual([{ projectId: expect.any(String), id: 'active1' }])
  })

  test('no order in the heartbeat response: nothing is dispatched', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const shipCalls: Array<{ projectId: string; id: string }> = []
    const replyCalls: Array<{ projectId: string; id: string; message: string }> = []
    const abandonCalls: Array<{ projectId: string; id: string }> = []
    const manager = fakeManager({ cwd, records: [record], shipCalls, replyCalls, abandonCalls })
    const calls: Call[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchHeartbeatOrder(null, calls),
      logFn: () => {},
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(shipCalls.length).toBe(0)
    expect(replyCalls.length).toBe(0)
    expect(abandonCalls.length).toBe(0)
  })

  test('a manager refusal applying an order is logged, not thrown', async () => {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
    initRepo(cwd, 'https://github.com/o/r.git')
    const record = fakeRecord({
      id: 'active1',
      status: 'waiting_for_you',
      hub_ticket: { id: 'tkt1', title: 'Add a thing' },
    })
    const manager = fakeManager({
      cwd,
      records: [record],
      shipResult: { ok: false, code: 409, error: 'ship in progress' },
    })
    const order = { action: 'ship', instruction: null, issued_at: '2026-01-01T00:00:00.000Z' }
    const calls: Call[] = []
    const lines: string[] = []
    const handle = startRunnerDaemon({
      manager,
      cwd,
      fetchImpl: fetchHeartbeatOrder(order, calls),
      logFn: (line) => lines.push(line),
      sleepFn: fastSleep,
    })
    await settle(30)
    await handle.stop()
    expect(lines.some((l) => l.includes('refused') && l.includes('ship in progress'))).toBe(true)
  })
})
