import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import {
  RUNBOOK_VERSION,
  type ArmTicket,
  type ArmTicketRequest,
  type RunbookConfig,
  type RunbookScan,
  type RunbookValidation,
  type TaskRecord,
} from './contract.js'
import type { HubResult } from './hub-client.js'
import type { SandboxDriver } from './microsandbox-driver.js'
import type { Project } from './projects.js'
import { DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS, type RunbookScanRunnerOptions } from './runbook-runner.js'
import { startRunnerDaemon } from './runner-daemon.js'
import type { RunnerSecretsPayload } from './runner-secrets.js'
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

const fakeRunnerIdentity = {
  publicKey: Buffer.from('pub'),
  privateKey: Buffer.from('priv'),
  fingerprint: 'fp1',
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

  describe('secret rotation', () => {
    test('no runner identity yet: skips without calling the hub', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const claimSecretCalls: unknown[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => null,
        claimSecretFn: async (...args) => {
          claimSecretCalls.push(args)
          return { ok: true, data: null }
        },
      })
      await handle.stop()
      expect(claimSecretCalls.length).toBe(0)
      expect(lines.some((l) => l.includes('no runner identity'))).toBe(true)
    })

    test('no pending secret: a silent no-op', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const applyCalls: unknown[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => fakeRunnerIdentity,
        claimSecretFn: async () => ({ ok: true, data: null }),
        applySecretsFn: (...args) => {
          applyCalls.push(args)
        },
      })
      await handle.stop()
      expect(applyCalls.length).toBe(0)
      expect(lines.length).toBe(0)
    })

    test('a valid blob mutates process.env, writes the env file, and logs only the key names', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const applyCalls: Array<{ envPath: string; secrets: Record<string, string> }> = []
      const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      const payload: RunnerSecretsPayload = {
        v: 1,
        secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value' },
      }
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => fakeRunnerIdentity,
        claimSecretFn: async () => ({ ok: true, data: { ciphertext: 'sealed-blob' } }),
        unsealFn: () => Buffer.from(JSON.stringify(payload), 'utf8'),
        sanitizeSecretsFn: (raw) => raw as RunnerSecretsPayload,
        applySecretsFn: (envPath, secrets) => {
          applyCalls.push({ envPath, secrets: secrets as Record<string, string> })
        },
      })
      await handle.stop()
      try {
        expect(applyCalls).toEqual([
          {
            envPath: expect.any(String),
            secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value' },
          },
        ])
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret-token-value')
        expect(lines.some((l) => l.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(true)
        expect(lines.some((l) => l.includes('secret-token-value'))).toBe(false)
      } finally {
        if (previousToken === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
        }
      }
    })

    test('a delivered git identity is applied through the seam and logged by name', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const applied: unknown[] = []
      const payload: RunnerSecretsPayload = {
        v: 1,
        secrets: {},
        git_identity: { name: 'Naash', email: 'naash@example.com' },
      }
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => fakeRunnerIdentity,
        claimSecretFn: async () => ({ ok: true, data: { ciphertext: 'sealed-blob' } }),
        unsealFn: () => Buffer.from(JSON.stringify(payload), 'utf8'),
        sanitizeSecretsFn: (raw) => raw as RunnerSecretsPayload,
        applySecretsFn: () => {},
        applyGitIdentityFn: (identity) => {
          applied.push(identity)
        },
      })
      await handle.stop()
      expect(applied).toEqual([{ name: 'Naash', email: 'naash@example.com' }])
      expect(lines.some((l) => l.includes('applied git identity: Naash'))).toBe(true)
    })

    test('an undecryptable blob logs a warning and mutates nothing', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const applyCalls: unknown[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => fakeRunnerIdentity,
        claimSecretFn: async () => ({ ok: true, data: { ciphertext: 'sealed-blob' } }),
        unsealFn: () => null,
        applySecretsFn: (...args) => {
          applyCalls.push(args)
        },
      })
      await handle.stop()
      expect(applyCalls.length).toBe(0)
      expect(lines.some((l) => l.includes('could not decrypt'))).toBe(true)
    })

    test('a payload that fails validation logs a warning and mutates nothing', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const applyCalls: unknown[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => fakeRunnerIdentity,
        claimSecretFn: async () => ({ ok: true, data: { ciphertext: 'sealed-blob' } }),
        unsealFn: () => Buffer.from('{"not":"a payload"}', 'utf8'),
        sanitizeSecretsFn: () => null,
        applySecretsFn: (...args) => {
          applyCalls.push(args)
        },
      })
      await handle.stop()
      expect(applyCalls.length).toBe(0)
      expect(lines.some((l) => l.includes('failed validation'))).toBe(true)
    })

    test('a network failure claiming the secret does not crash the tick', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadIdentityFn: () => fakeRunnerIdentity,
        claimSecretFn: (): Promise<HubResult<{ ciphertext: string } | null>> =>
          Promise.resolve({ ok: false, error: { kind: 'network' } }),
      })
      await handle.stop()
      expect(lines.some((l) => l.includes('tick failed'))).toBe(false)
    })
  })

  describe('runbook scan tick', () => {
    function connect(): void {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
    }

    test('isolation is not "microvm": never calls runOneRunbookScanFn', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      let called = false
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: () => {},
        runOneRunbookScanFn: async () => {
          called = true
          return { claimed: false }
        },
      })
      await handle.stop()
      expect(called).toBe(false)
    })

    test('isolation "microvm" but no agent configured: logs once, never calls runOneRunbookScanFn', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      let called = false
      const lines: string[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadConfigFn: () => ({ isolation: 'microvm' }),
        runOneRunbookScanFn: async () => {
          called = true
          return { claimed: false }
        },
      })
      await handle.stop()
      expect(called).toBe(false)
      expect(lines.filter((l) => l.includes('no agent command is configured')).length).toBe(1)
    })

    test('isolation "microvm" with an agent: calls runOneRunbookScanFn with the configured command, secrets from the environment and a resolver', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-secret'
      const seen: {
        command: string | null
        timeoutMs: number | null
        secrets: RunbookScanRunnerOptions['secrets'] | null
        resolveWorktree: RunbookScanRunnerOptions['resolveWorktree'] | null
      } = { command: null, timeoutMs: null, secrets: null, resolveWorktree: null }
      try {
        const handle = startRunnerDaemon({
          manager,
          cwd,
          fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
          logFn: () => {},
          loadConfigFn: () => ({ isolation: 'microvm', agent: 'claude -p' }),
          driver: {} as SandboxDriver,
          runOneRunbookScanFn: async (opts) => {
            seen.command = opts.command
            seen.timeoutMs = opts.timeoutMs
            seen.secrets = opts.secrets
            seen.resolveWorktree = opts.resolveWorktree
            return { claimed: false }
          },
        })
        await handle.stop()
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
        }
      }
      expect(seen.command).toBe('claude -p')
      expect(seen.timeoutMs).toBe(DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS)
      expect(seen.secrets).toEqual([
        { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-secret', allowedHosts: expect.any(Array) },
      ])
      expect(seen.resolveWorktree).not.toBeNull()
    })

    test('a claimed scan is logged with its outcome status', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      const lines: string[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadConfigFn: () => ({ isolation: 'microvm', agent: 'claude -p' }),
        driver: {} as SandboxDriver,
        runOneRunbookScanFn: async () => ({
          claimed: true,
          scanId: 'scan1',
          outcome: {
            status: 'completed',
            runbook: {
              version: RUNBOOK_VERSION,
              image: 'node:26',
              install: [],
              services: { host_up: [], compose_file: null },
              healthchecks: [],
              tests: ['bun test'],
              egress: [],
              depends_on_files: [],
            } satisfies RunbookConfig,
            validation: {
              runbook_sha: '0123456789abcdef',
              validated_sha: 'a'.repeat(40),
              validated_at: '2026-01-01T00:00:00.000Z',
              status: 'valid',
            } satisfies RunbookValidation,
            snapshotName: null,
            checks: [],
            attempts: 1,
          },
        }),
      })
      await handle.stop()
      expect(lines.some((l) => l.includes('runbook scan scan1: completed'))).toBe(true)
    })

    test('runOneRunbookScanFn throwing is logged, not thrown, and the rest of the tick still runs', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const createCalls: { projectId: string; input: unknown }[] = []
      const manager = fakeManager({
        cwd,
        createCalls,
        createResult: { ok: true, record: fakeRecord({ id: 'newtask' }) },
      })
      const lines: string[] = []
      const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes('/tickets?')) {
          return new Response(JSON.stringify({ tickets: [validTicket] }), { status: 200 })
        }
        if (href.endsWith('/claim')) {
          return new Response(
            JSON.stringify({ ticket: validTicket, lease_expires_at: '2026-01-01T00:05:00.000Z' }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ requests: [] }), { status: 200 })
      }) as unknown as typeof fetch
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl,
        logFn: (line) => lines.push(line),
        loadConfigFn: () => ({ isolation: 'microvm', agent: 'claude -p' }),
        driver: {} as SandboxDriver,
        runOneRunbookScanFn: async () => {
          throw new Error('vm exploded')
        },
      })
      await handle.stop()
      expect(lines.some((l) => l.includes('runbook scan tick failed: vm exploded'))).toBe(true)
      // the ticket claim after it in the tick still ran.
      expect(createCalls.length).toBe(1)
    })

    test('no driver override: a driver factory that throws is caught and logged once, not thrown', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      let called = false
      const lines: string[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadConfigFn: () => ({ isolation: 'microvm', agent: 'claude -p' }),
        createDriverFn: () => {
          throw new Error('no /dev/kvm')
        },
        runOneRunbookScanFn: async () => {
          called = true
          return { claimed: false }
        },
      })
      await handle.stop()
      expect(called).toBe(false)
      expect(lines.some((l) => l.includes('microVM driver unavailable: no /dev/kvm'))).toBe(true)
    })

    test('the driver factory throwing is only logged once across ticks (logOnce)', async () => {
      connect()
      initRepo(cwd, 'https://github.com/o/r.git')
      const manager = fakeManager({ cwd })
      let factoryCalls = 0
      const lines: string[] = []
      const handle = startRunnerDaemon({
        manager,
        cwd,
        intervalMs: 1,
        sleepFn: fastSleep,
        fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
        logFn: (line) => lines.push(line),
        loadConfigFn: () => ({ isolation: 'microvm', agent: 'claude -p' }),
        createDriverFn: () => {
          factoryCalls += 1
          throw new Error('no /dev/kvm')
        },
        runOneRunbookScanFn: async () => ({ claimed: false }),
      })
      await settle(20)
      await handle.stop()
      expect(factoryCalls).toBeGreaterThan(1)
      expect(lines.filter((l) => l.includes('microVM driver unavailable')).length).toBe(1)
    })

    describe('resolveWorktree (the resolver handed to runOneRunbookScanFn)', () => {
      function fakeScan(overrides: Partial<RunbookScan> = {}): RunbookScan {
        return {
          id: '11111111-1111-1111-1111-111111111111',
          repo_id: '22222222-2222-2222-2222-222222222222',
          repo_full_name: 'o/r',
          head_sha: null,
          status: 'queued',
          requested_at: '2026-01-01T00:00:00.000Z',
          ...overrides,
        }
      }

      async function captureResolver(
        originUrl: string,
      ): Promise<RunbookScanRunnerOptions['resolveWorktree']> {
        connect()
        initRepo(cwd, originUrl)
        const manager = fakeManager({ cwd })
        let resolver: RunbookScanRunnerOptions['resolveWorktree'] | null = null
        const handle = startRunnerDaemon({
          manager,
          cwd,
          fetchImpl: fetchStub(200, { requests: [], tickets: [] }, []),
          logFn: () => {},
          loadConfigFn: () => ({ isolation: 'microvm', agent: 'claude -p' }),
          driver: {} as SandboxDriver,
          runOneRunbookScanFn: async (opts) => {
            resolver = opts.resolveWorktree
            return { claimed: false }
          },
        })
        await handle.stop()
        if (!resolver) {
          throw new Error('resolver never captured')
        }
        return resolver
      }

      test('an https origin resolves a scan naming the same owner/repo', async () => {
        const resolver = await captureResolver('https://github.com/o/r.git')
        const resolved = await resolver(fakeScan({ repo_full_name: 'o/r' }))
        expect(resolved).not.toBeNull()
        expect(resolved?.worktree).toBe(cwd)
        expect(resolved?.projectId).toBe('22222222-2222-2222-2222-222222222222')
        expect(resolved?.headSha).toMatch(/^[0-9a-f]{40}$/)
      })

      test('matching is case-insensitive', async () => {
        const resolver = await captureResolver('https://github.com/o/r.git')
        const resolved = await resolver(fakeScan({ repo_full_name: 'O/R' }))
        expect(resolved).not.toBeNull()
      })

      test('an ssh origin resolves the same way as its https equivalent', async () => {
        const resolver = await captureResolver('git@github.com:o/r.git')
        const resolved = await resolver(fakeScan({ repo_full_name: 'o/r' }))
        expect(resolved).not.toBeNull()
      })

      test('a scan naming a different repository resolves to null', async () => {
        const resolver = await captureResolver('https://github.com/o/r.git')
        const resolved = await resolver(fakeScan({ repo_full_name: 'someone/else' }))
        expect(resolved).toBeNull()
      })

      test('a scan whose head_sha matches the local HEAD resolves normally', async () => {
        const resolver = await captureResolver('https://github.com/o/r.git')
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim()
        const resolved = await resolver(fakeScan({ repo_full_name: 'o/r', head_sha: headSha }))
        expect(resolved).not.toBeNull()
        expect(resolved?.headSha).toBe(headSha)
      })

      test('head_sha matching is case-insensitive', async () => {
        const resolver = await captureResolver('https://github.com/o/r.git')
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim()
        const resolved = await resolver(
          fakeScan({ repo_full_name: 'o/r', head_sha: headSha.toUpperCase() }),
        )
        expect(resolved).not.toBeNull()
      })

      test('a scan whose head_sha does not match the local HEAD resolves to null (skips this tick instead of validating the wrong commit)', async () => {
        const resolver = await captureResolver('https://github.com/o/r.git')
        const resolved = await resolver(
          fakeScan({ repo_full_name: 'o/r', head_sha: 'f'.repeat(40) }),
        )
        expect(resolved).toBeNull()
      })
    })
  })
})
