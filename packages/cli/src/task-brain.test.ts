import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ArmOrder, TaskEvent, TaskRecord, TaskTurn } from './contract.js'
import {
  flushBrainOutbox,
  heartbeatBrainTicket,
  queueBrainEvent,
  reportBrainTransition,
  resetPendingBrainEventBatches,
} from './task-brain.js'

type Call = { url: string; init: RequestInit }

/** Same stub as sync.test.ts: records every call, answers one fixed response. */
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

/** Never resolves the network call at all: offline. */
function fetchOffline(message = 'network unreachable'): typeof fetch {
  return (() => Promise.reject(new Error(message))) as unknown as typeof fetch
}

function requestBody(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

function outboxPath(cwd: string): string {
  return join(cwd, '.codesema', 'brain-outbox.jsonl')
}

function outboxLines(cwd: string): unknown[] {
  if (!existsSync(outboxPath(cwd))) {
    return []
  }
  return readFileSync(outboxPath(cwd), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function settle(): Promise<void> {
  // Lets a fire-and-forget effect's own microtask/macrotask chain (fetchStub's
  // resolved Response, its own .then chain inside postToBrain) run to
  // completion before an assertion reads its side effect.
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function fakeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'abc123def456',
    title: 't',
    status: 'shipped',
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
    brain_ticket: { id: 'tkt-1', title: 't' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function fakeTurn(): TaskTurn {
  return {
    prompt: 'do work',
    response: null,
    question: null,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
  }
}

function fakeEvent(seq: number): TaskEvent {
  return { seq, at: '2026-01-01T00:00:00.000Z', type: 'commit', data: { message: `commit ${seq}` } }
}

/** exactOptionalPropertyTypes forbids `{ brain_ticket: undefined }`: the key must be ABSENT, not present-as-undefined. */
function withoutBrainTicket(record: TaskRecord): TaskRecord {
  const { brain_ticket: _dropped, ...rest } = record
  return rest
}

describe('task-brain', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-brain-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-brain-repo-'))
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://brain.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
  })

  afterEach(() => {
    resetPendingBrainEventBatches()
    rmSync(configDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
  })

  describe('reportBrainTransition', () => {
    test('a successful report carries the right URL, Bearer header and body', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      await reportBrainTransition(
        cwd,
        record,
        { type: 'mr_opened', mr_url: 'https://forge.example/mr/1', branch: 'codesema/task-t' },
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/tickets/tkt-1/transitions')
      expect(calls[0]?.init.method).toBe('POST')
      const headers = calls[0]?.init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer csk_ws1.sec1')
      const body = requestBody(calls[0] as Call)
      expect(body.type).toBe('mr_opened')
      expect(body.mr_url).toBe('https://forge.example/mr/1')
      expect(body.branch).toBe('codesema/task-t')
      expect(body.idempotency_key).toBe('abc123def456:mr_opened:0')
      expect(typeof body.at).toBe('string')
      // Nothing queued: a successful send never touches the outbox.
      expect(outboxLines(cwd)).toEqual([])
    })

    test('two review_result reports for the same task at different turn counts get distinct idempotency keys', async () => {
      // A fix-loop round settles a SECOND, genuinely different verdict on the
      // same task; the brain must not read it as a retry of the first and
      // drop it as an already-applied duplicate.
      const calls: Call[] = []
      const fetchImpl = fetchStub(200, {}, calls)
      await reportBrainTransition(
        cwd,
        fakeRecord({ turns: [] }),
        { type: 'review_result', verdict: 'request_changes' },
        fetchImpl,
      )
      await reportBrainTransition(
        cwd,
        fakeRecord({ turns: [fakeTurn()] }),
        { type: 'review_result', verdict: 'approve' },
        fetchImpl,
      )
      const keys = calls.map((call) => requestBody(call).idempotency_key)
      expect(keys).toEqual(['abc123def456:review_result:0', 'abc123def456:review_result:1'])
    })

    test('a task with no brain_ticket is a no-op', async () => {
      const calls: Call[] = []
      const record = withoutBrainTicket(fakeRecord())
      await reportBrainTransition(cwd, record, { type: 'mr_opened' }, fetchStub(200, {}, calls))
      expect(calls.length).toBe(0)
    })

    test('a network failure queues the report in the outbox', async () => {
      const record = fakeRecord()
      await reportBrainTransition(cwd, record, { type: 'merged' }, fetchOffline())
      const lines = outboxLines(cwd)
      expect(lines.length).toBe(1)
      const entry = lines[0] as { kind: string; ticket_id: string; transition: { type: string } }
      expect(entry.kind).toBe('transition')
      expect(entry.ticket_id).toBe('tkt-1')
      expect(entry.transition.type).toBe('merged')
    })

    test('a 5xx queues the report in the outbox', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      await reportBrainTransition(
        cwd,
        record,
        { type: 'merged' },
        fetchStub(503, { error: 'down' }, calls),
      )
      expect(outboxLines(cwd).length).toBe(1)
    })

    test('a 4xx is logged and abandoned, never queued', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      await reportBrainTransition(
        cwd,
        record,
        { type: 'failed', error_message: 'boom' },
        fetchStub(409, { error: 'already applied' }, calls),
      )
      expect(calls.length).toBe(1)
      expect(outboxLines(cwd)).toEqual([])
    })
  })

  describe('flushBrainOutbox', () => {
    test('replays a queued transition and empties the outbox on success', async () => {
      const record = fakeRecord()
      await reportBrainTransition(cwd, record, { type: 'merged' }, fetchOffline())
      expect(outboxLines(cwd).length).toBe(1)

      const calls: Call[] = []
      await flushBrainOutbox(cwd, fetchStub(200, {}, calls))
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/tickets/tkt-1/transitions')
      expect(outboxLines(cwd)).toEqual([])
    })

    test('a 409 on replay drops the entry rather than keeping it queued', async () => {
      const record = fakeRecord()
      await reportBrainTransition(cwd, record, { type: 'merged' }, fetchOffline())
      expect(outboxLines(cwd).length).toBe(1)

      const calls: Call[] = []
      await flushBrainOutbox(cwd, fetchStub(409, { error: 'already applied' }, calls))
      expect(calls.length).toBe(1)
      expect(outboxLines(cwd)).toEqual([])
    })

    test('still offline: the entry is kept, not lost', async () => {
      const record = fakeRecord()
      await reportBrainTransition(cwd, record, { type: 'merged' }, fetchOffline())
      expect(outboxLines(cwd).length).toBe(1)

      await flushBrainOutbox(cwd, fetchOffline('still offline'))
      expect(outboxLines(cwd).length).toBe(1)
    })

    test('no outbox file: a no-op', async () => {
      const calls: Call[] = []
      await flushBrainOutbox(cwd, fetchStub(200, {}, calls))
      expect(calls.length).toBe(0)
    })
  })

  describe('heartbeatBrainTicket', () => {
    test('posts to the ticket heartbeat route with the Bearer header', async () => {
      const calls: Call[] = []
      await heartbeatBrainTicket(cwd, fakeRecord(), undefined, fetchStub(200, {}, calls))
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/tickets/tkt-1/heartbeat')
      const headers = calls[0]?.init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer csk_ws1.sec1')
    })

    test('a task with no brain_ticket is a no-op', async () => {
      const calls: Call[] = []
      await heartbeatBrainTicket(
        cwd,
        withoutBrainTicket(fakeRecord()),
        undefined,
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(0)
    })

    test('sends local_status in the body when given', async () => {
      const calls: Call[] = []
      await heartbeatBrainTicket(cwd, fakeRecord(), 'waiting_for_you', fetchStub(200, {}, calls))
      expect(requestBody(calls[0] as Call)).toEqual({ local_status: 'waiting_for_you' })
    })

    test('omits local_status from the body when not given', async () => {
      const calls: Call[] = []
      await heartbeatBrainTicket(cwd, fakeRecord(), undefined, fetchStub(200, {}, calls))
      expect(requestBody(calls[0] as Call)).toEqual({})
    })

    test('returns the sanitized order the brain hands back', async () => {
      const order: ArmOrder = {
        action: 'ship',
        instruction: null,
        issued_at: '2026-01-01T00:00:00.000Z',
      }
      const fetchImpl = fetchStub(200, { lease_expires_at: '2026-01-01T00:05:00.000Z', order }, [])
      const result = await heartbeatBrainTicket(cwd, fakeRecord(), undefined, fetchImpl)
      expect(result).toEqual(order)
    })

    test('returns null when the response carries no order', async () => {
      const fetchImpl = fetchStub(
        200,
        { lease_expires_at: '2026-01-01T00:05:00.000Z', order: null },
        [],
      )
      const result = await heartbeatBrainTicket(cwd, fakeRecord(), undefined, fetchImpl)
      expect(result).toBeNull()
    })

    test('returns null, without throwing, when the success body is empty or not JSON', async () => {
      const fetchImpl = (() =>
        Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch
      const result = await heartbeatBrainTicket(cwd, fakeRecord(), undefined, fetchImpl)
      expect(result).toBeNull()
    })

    test('returns null, without throwing, on a network failure', async () => {
      const result = await heartbeatBrainTicket(cwd, fakeRecord(), undefined, fetchOffline())
      expect(result).toBeNull()
    })
  })

  describe('queueBrainEvent', () => {
    test('flushes once the batch reaches its cap, as one POST /api/cli/events', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      const fetchImpl = fetchStub(200, {}, calls)
      for (let i = 1; i <= 20; i++) {
        queueBrainEvent({
          cwd,
          taskId: record.id,
          ticketId: record.brain_ticket?.id ?? '',
          event: fakeEvent(i),
          fetchImpl,
        })
      }
      await settle()
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/events')
      const body = requestBody(calls[0] as Call)
      expect(body.run_id).toBe(record.id)
      expect(body.ticket_id).toBe('tkt-1')
      expect(Array.isArray(body.events)).toBe(true)
      expect((body.events as unknown[]).length).toBe(20)
    })

    test('the origin remote is cached per cwd: a second flush reuses it even once the repo origin is gone', async () => {
      execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], {
        cwd,
        stdio: 'ignore',
      })
      const calls: Call[] = []
      const fetchImpl = fetchStub(200, {}, calls)
      for (let i = 1; i <= 20; i++) {
        queueBrainEvent({
          cwd,
          taskId: 'task-a',
          ticketId: 'tkt-1',
          event: fakeEvent(i),
          fetchImpl,
        })
      }
      await settle()
      expect(calls.length).toBe(1)
      expect(requestBody(calls[0] as Call).remote_url).toBe('git@github.com:o/r.git')

      // The repo's origin is gone: an uncached read would now answer null.
      // A second batch, same cwd, different task: it must still carry the
      // cached URL rather than a fresh (and now null) read.
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd, stdio: 'ignore' })
      for (let i = 1; i <= 20; i++) {
        queueBrainEvent({
          cwd,
          taskId: 'task-b',
          ticketId: 'tkt-1',
          event: fakeEvent(i),
          fetchImpl,
        })
      }
      await settle()
      expect(calls.length).toBe(2)
      expect(requestBody(calls[1] as Call).remote_url).toBe('git@github.com:o/r.git')
    })
  })
})
