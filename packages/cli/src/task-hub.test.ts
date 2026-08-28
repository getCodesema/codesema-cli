import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ArmOrder, ArmTicket, TaskEvent, TaskRecord, TaskTurn } from './contract.js'
import {
  flushHubOutbox,
  heartbeatHubTicket,
  queueHubEvent,
  reportHubTransition,
  resetPendingHubEventBatches,
  type ArmTransitionDraft,
} from './task-hub.js'
import { loadTask, saveTask } from './tasks-store.js'

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
  return join(cwd, '.codesema', 'hub-outbox.jsonl')
}

function legacyOutboxPath(cwd: string): string {
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
  // resolved Response, its own .then chain inside postToHub) run to
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
    hub_ticket: { id: 'tkt-1', title: 't' },
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

/** exactOptionalPropertyTypes forbids `{ hub_ticket: undefined }`: the key must be ABSENT, not present-as-undefined. */
function withoutHubTicket(record: TaskRecord): TaskRecord {
  const { hub_ticket: _dropped, ...rest } = record
  return rest
}

function fakeArmTicket(status: ArmTicket['status']): ArmTicket {
  return {
    id: 'tkt-1',
    repo_remote_url: 'https://github.com/o/r.git',
    title: 't',
    body: 'b',
    status,
    depends_on: null,
    executed_by: 'cli:ws1',
    lease_expires_at: null,
    issue: null,
    branch: 'codesema/task-t',
    mr_iid: null,
    mr_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

describe('task-hub', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-hub-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-hub-repo-'))
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: 'https://hub.example',
      syncWorkspaceId: 'ws1',
      syncSecret: 'sec1',
    })
  })

  afterEach(() => {
    resetPendingHubEventBatches()
    rmSync(configDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
  })

  describe('reportHubTransition', () => {
    test('a successful report carries the right URL, Bearer header and body', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      await reportHubTransition(
        cwd,
        record,
        { type: 'mr_opened', mr_url: 'https://forge.example/mr/1', branch: 'codesema/task-t' },
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://hub.example/api/cli/tickets/tkt-1/transitions')
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
      // same task; the hub must not read it as a retry of the first and
      // drop it as an already-applied duplicate.
      const calls: Call[] = []
      const fetchImpl = fetchStub(200, {}, calls)
      await reportHubTransition(
        cwd,
        fakeRecord({ turns: [] }),
        { type: 'review_result', verdict: 'request_changes' },
        fetchImpl,
      )
      await reportHubTransition(
        cwd,
        fakeRecord({ turns: [fakeTurn()] }),
        { type: 'review_result', verdict: 'approve' },
        fetchImpl,
      )
      const keys = calls.map((call) => requestBody(call).idempotency_key)
      expect(keys).toEqual(['abc123def456:review_result:0', 'abc123def456:review_result:1'])
    })

    test('a task with no hub_ticket is a no-op', async () => {
      const calls: Call[] = []
      const record = withoutHubTicket(fakeRecord())
      await reportHubTransition(
        cwd,
        record,
        { type: 'mr_opened', mr_url: 'https://hub.example/mr/1' },
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(0)
    })

    test('a network failure queues the report in the outbox', async () => {
      const record = fakeRecord()
      await reportHubTransition(
        cwd,
        record,
        { type: 'merged', merge_sha: 'a1b2c3d4e5' },
        fetchOffline(),
      )
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
      await reportHubTransition(
        cwd,
        record,
        { type: 'merged', merge_sha: 'a1b2c3d4e5' },
        fetchStub(503, { error: 'down' }, calls),
      )
      expect(outboxLines(cwd).length).toBe(1)
    })

    test('a 4xx is logged and abandoned, never queued', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      await reportHubTransition(
        cwd,
        record,
        { type: 'failed', error_message: 'boom' },
        fetchStub(409, { error: 'already applied' }, calls),
      )
      expect(calls.length).toBe(1)
      expect(outboxLines(cwd)).toEqual([])
    })

    test('a report without its proof is refused before any network call', async () => {
      const calls: Call[] = []
      // The compiler already forbids this shape; the cast proves the RUNTIME
      // gate holds for a record that reached here past it (a replayed file,
      // an older caller).
      await reportHubTransition(
        cwd,
        fakeRecord(),
        { type: 'mr_opened' } as unknown as ArmTransitionDraft,
        fetchStub(200, {}, calls),
      )
      await reportHubTransition(
        cwd,
        fakeRecord(),
        { type: 'merged' } as unknown as ArmTransitionDraft,
        fetchStub(200, {}, calls),
      )
      expect(calls).toEqual([])
      expect(outboxLines(cwd)).toEqual([])
    })

    test('an out-of-table transition is refused before any network call', async () => {
      const calls: Call[] = []
      const record = fakeRecord({ hub_ticket_status: 'published' })
      await reportHubTransition(
        cwd,
        record,
        { type: 'mr_opened', mr_url: 'https://hub.example/mr/1' },
        fetchStub(200, {}, calls),
      )
      expect(calls).toEqual([])
      expect(outboxLines(cwd)).toEqual([])
    })

    test('an unknown local hub status lets the report through: the hub revalidates', async () => {
      const calls: Call[] = []
      await reportHubTransition(
        cwd,
        fakeRecord(),
        { type: 'mr_opened', mr_url: 'https://hub.example/mr/1' },
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(1)
    })

    test('a legal transition from the last known status is posted', async () => {
      const calls: Call[] = []
      const record = fakeRecord({ hub_ticket_status: 'in_progress' })
      await reportHubTransition(
        cwd,
        record,
        { type: 'mr_opened', mr_url: 'https://hub.example/mr/1' },
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(1)
    })

    test('a review verdict short of approve is not a transition: never table-checked', async () => {
      const calls: Call[] = []
      const record = fakeRecord({ hub_ticket_status: 'published' })
      await reportHubTransition(
        cwd,
        record,
        { type: 'review_result', verdict: 'request_changes' },
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(1)
    })

    test('the ticket status the hub answers with is remembered on the record', async () => {
      const record = fakeRecord({ hub_ticket_status: 'mr_opened' })
      saveTask(cwd, record)
      await reportHubTransition(
        cwd,
        record,
        { type: 'review_result', verdict: 'approve' },
        fetchStub(200, { ticket: fakeArmTicket('ready_to_merge') }, []),
      )
      expect(loadTask(cwd, record.id)?.hub_ticket_status).toBe('ready_to_merge')
    })

    test('an answer without a readable ticket leaves the last known status alone', async () => {
      const record = fakeRecord({ hub_ticket_status: 'mr_opened' })
      saveTask(cwd, record)
      await reportHubTransition(
        cwd,
        record,
        { type: 'review_result', verdict: 'approve' },
        fetchStub(200, {}, []),
      )
      expect(loadTask(cwd, record.id)?.hub_ticket_status).toBe('mr_opened')
    })
  })

  describe('flushHubOutbox', () => {
    test('replays a queued transition and empties the outbox on success', async () => {
      const record = fakeRecord()
      await reportHubTransition(
        cwd,
        record,
        { type: 'merged', merge_sha: 'a1b2c3d4e5' },
        fetchOffline(),
      )
      expect(outboxLines(cwd).length).toBe(1)

      const calls: Call[] = []
      await flushHubOutbox(cwd, fetchStub(200, {}, calls))
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://hub.example/api/cli/tickets/tkt-1/transitions')
      expect(outboxLines(cwd)).toEqual([])
    })

    test('a 409 on replay drops the entry rather than keeping it queued', async () => {
      const record = fakeRecord()
      await reportHubTransition(
        cwd,
        record,
        { type: 'merged', merge_sha: 'a1b2c3d4e5' },
        fetchOffline(),
      )
      expect(outboxLines(cwd).length).toBe(1)

      const calls: Call[] = []
      await flushHubOutbox(cwd, fetchStub(409, { error: 'already applied' }, calls))
      expect(calls.length).toBe(1)
      expect(outboxLines(cwd)).toEqual([])
    })

    test('still offline: the entry is kept, not lost', async () => {
      const record = fakeRecord()
      await reportHubTransition(
        cwd,
        record,
        { type: 'merged', merge_sha: 'a1b2c3d4e5' },
        fetchOffline(),
      )
      expect(outboxLines(cwd).length).toBe(1)

      await flushHubOutbox(cwd, fetchOffline('still offline'))
      expect(outboxLines(cwd).length).toBe(1)
    })

    test('no outbox file: a no-op', async () => {
      const calls: Call[] = []
      await flushHubOutbox(cwd, fetchStub(200, {}, calls))
      expect(calls.length).toBe(0)
    })
  })

  describe('heartbeatHubTicket', () => {
    test('posts to the ticket heartbeat route with the Bearer header', async () => {
      const calls: Call[] = []
      await heartbeatHubTicket(cwd, fakeRecord(), undefined, fetchStub(200, {}, calls))
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://hub.example/api/cli/tickets/tkt-1/heartbeat')
      const headers = calls[0]?.init.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer csk_ws1.sec1')
    })

    test('a task with no hub_ticket is a no-op', async () => {
      const calls: Call[] = []
      await heartbeatHubTicket(
        cwd,
        withoutHubTicket(fakeRecord()),
        undefined,
        fetchStub(200, {}, calls),
      )
      expect(calls.length).toBe(0)
    })

    test('sends local_status in the body when given', async () => {
      const calls: Call[] = []
      await heartbeatHubTicket(cwd, fakeRecord(), 'waiting_for_you', fetchStub(200, {}, calls))
      expect(requestBody(calls[0] as Call)).toEqual({ local_status: 'waiting_for_you' })
    })

    test('omits local_status from the body when not given', async () => {
      const calls: Call[] = []
      await heartbeatHubTicket(cwd, fakeRecord(), undefined, fetchStub(200, {}, calls))
      expect(requestBody(calls[0] as Call)).toEqual({})
    })

    test('returns the sanitized order the hub hands back', async () => {
      const order: ArmOrder = {
        action: 'ship',
        instruction: null,
        issued_at: '2026-01-01T00:00:00.000Z',
      }
      const fetchImpl = fetchStub(200, { lease_expires_at: '2026-01-01T00:05:00.000Z', order }, [])
      const result = await heartbeatHubTicket(cwd, fakeRecord(), undefined, fetchImpl)
      expect(result).toEqual(order)
    })

    test('returns null when the response carries no order', async () => {
      const fetchImpl = fetchStub(
        200,
        { lease_expires_at: '2026-01-01T00:05:00.000Z', order: null },
        [],
      )
      const result = await heartbeatHubTicket(cwd, fakeRecord(), undefined, fetchImpl)
      expect(result).toBeNull()
    })

    test('returns null, without throwing, when the success body is empty or not JSON', async () => {
      const fetchImpl = (() =>
        Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch
      const result = await heartbeatHubTicket(cwd, fakeRecord(), undefined, fetchImpl)
      expect(result).toBeNull()
    })

    test('returns null, without throwing, on a network failure', async () => {
      const result = await heartbeatHubTicket(cwd, fakeRecord(), undefined, fetchOffline())
      expect(result).toBeNull()
    })
  })

  describe('queueHubEvent', () => {
    test('flushes once the batch reaches its cap, as one POST /api/cli/events', async () => {
      const calls: Call[] = []
      const record = fakeRecord()
      const fetchImpl = fetchStub(200, {}, calls)
      for (let i = 1; i <= 20; i++) {
        queueHubEvent({
          cwd,
          taskId: record.id,
          ticketId: record.hub_ticket?.id ?? '',
          event: fakeEvent(i),
          fetchImpl,
        })
      }
      await settle()
      expect(calls.length).toBe(1)
      expect(calls[0]?.url).toBe('https://hub.example/api/cli/events')
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
        queueHubEvent({
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
        queueHubEvent({
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

  describe('legacy brain-outbox.jsonl migration', () => {
    function writeLegacyOutbox(entries: unknown[]): void {
      mkdirSync(join(cwd, '.codesema'), { recursive: true })
      writeFileSync(
        legacyOutboxPath(cwd),
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      )
    }

    test('a legacy outbox is renamed and its entries replayed by flushHubOutbox', async () => {
      writeLegacyOutbox([
        {
          kind: 'transition',
          key: 'legacy-1',
          ticket_id: 'tkt-1',
          transition: {
            type: 'merged',
            idempotency_key: 'legacy-1',
            at: '2026-01-01T00:00:00.000Z',
          },
        },
      ])
      const calls: Call[] = []
      await flushHubOutbox(cwd, fetchStub(200, {}, calls))
      expect(calls.length).toBe(1)
      expect(existsSync(legacyOutboxPath(cwd))).toBe(false)
      expect(outboxLines(cwd)).toEqual([])
    })

    test('a legacy outbox is migrated on write too: a new offline report lands beside the old entries', async () => {
      writeLegacyOutbox([
        {
          kind: 'transition',
          key: 'legacy-1',
          ticket_id: 'tkt-1',
          transition: {
            type: 'merged',
            idempotency_key: 'legacy-1',
            at: '2026-01-01T00:00:00.000Z',
          },
        },
      ])
      await reportHubTransition(cwd, fakeRecord(), { type: 'failed' }, fetchOffline())
      expect(existsSync(legacyOutboxPath(cwd))).toBe(false)
      expect(outboxLines(cwd).length).toBe(2)
    })

    test('a legacy file reappearing after hub-outbox.jsonl already exists is never touched again', async () => {
      await reportHubTransition(cwd, fakeRecord(), { type: 'failed' }, fetchOffline())
      expect(outboxLines(cwd).length).toBe(1)
      // hub-outbox.jsonl already exists (even once flushed empty below), so the
      // migration guard (`!existsSync(path)`) skips a legacy file from here on.
      writeLegacyOutbox([
        { kind: 'transition', key: 'legacy-2', ticket_id: 'tkt-1', transition: {} },
      ])
      await flushHubOutbox(cwd, fetchStub(200, {}, []))
      expect(existsSync(legacyOutboxPath(cwd))).toBe(true)
      expect(outboxLines(cwd)).toEqual([])
    })
  })
})
