import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  ArmTicket,
  ArmTicketRequest,
  RunbookConfig,
  RunbookScan,
  RunbookValidation,
  RunnerListEntry,
  TaskVerification,
} from './contract.js'
import {
  claimPendingSecret,
  claimRunbookScan,
  claimTicket,
  claimTicketRequest,
  createTicket,
  currentRunbook,
  depositRunnerSecret,
  failRunbookScan,
  failTicketRequest,
  getTicket,
  heartbeat,
  hubErrorMessage,
  listInFlightTickets,
  listRunbookScans,
  listRunners,
  listTicketRequests,
  listTickets,
  parseHubToken,
  pushEvents,
  registerRunnerKey,
  reportRunbookScanResult,
  submitTicketRequestTickets,
  transition,
  verification,
} from './hub-client.js'
import { loadOrCreateRunnerIdentity } from './runner-identity.js'
import type { SyncCredentials } from './sync.js'

type Call = { url: string; init: RequestInit }

/** Same stub as sync.test.ts / task-hub.test.ts: records every call, answers one fixed response. */
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
  return (() => Promise.reject(new Error('network unreachable'))) as unknown as typeof fetch
}

const creds: SyncCredentials = { url: 'https://hub.example', workspaceId: 'w1', secret: 's1' }

const validTicket: ArmTicket = {
  id: 't1',
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

const validRequest: ArmTicketRequest = {
  id: 'r1',
  repo_remote_url: 'https://github.com/o/r.git',
  prompt: 'add a thing',
  status: 'queued',
  source_issue: null,
  created_at: '2026-01-01T00:00:00.000Z',
}

const validRunbook: RunbookConfig = {
  version: 1,
  image: 'node:26',
  install: ['npm install'],
  services: { host_up: [], compose_file: null },
  healthchecks: [],
  tests: ['npm test'],
  egress: ['registry.npmjs.org'],
  depends_on_files: ['package.json'],
}

const validRunbookValidation: RunbookValidation = {
  runbook_sha: '0123456789abcdef',
  validated_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  validated_at: '2026-01-01T00:00:00.000Z',
  status: 'valid',
}

const validRunbookScan: RunbookScan = {
  id: '11111111-1111-1111-1111-111111111111',
  repo_id: '22222222-2222-2222-2222-222222222222',
  repo_full_name: 'o/r',
  head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  status: 'queued',
  requested_at: '2026-01-01T00:00:00.000Z',
}

const validVerification: TaskVerification = {
  head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  runbook_sha: '0123456789abcdef',
  started_at: '2026-01-01T00:00:00.000Z',
  finished_at: '2026-01-01T00:05:00.000Z',
  status: 'passed',
  checks: [],
  integrity_ok: true,
  changed_dependency_files: [],
  error: null,
}

/** A sha256 hex digest (fingerprint) and a base64-encoded 32-byte key (public_key): the exact shapes `sanitizeRunnerListEntry` requires, not placeholders. */
const validRunnerListEntry: RunnerListEntry = {
  name: 'my-laptop',
  fingerprint: '597fbc141b11df74a6642a6d8381d1b77ae49de801b177957cfa624fc13db748',
  public_key: '6y91HfIciBvPrgZlyIYTjRcUvzSzlEJQroZRfdEPx5M=',
  last_seen_at: '2026-01-01T00:00:00.000Z',
  has_pending_secret: false,
}

describe('parseHubToken', () => {
  test('splits on the first dot', () => {
    expect(parseHubToken('csk_ws1.se.cret')).toEqual({ workspaceId: 'ws1', secret: 'se.cret' })
  })

  test('rejects a token missing the csk_ prefix', () => {
    expect(parseHubToken('ws1.secret')).toBeNull()
  })

  test('rejects a token with no dot', () => {
    expect(parseHubToken('csk_ws1secret')).toBeNull()
  })

  test('rejects an empty workspace id or secret', () => {
    expect(parseHubToken('csk_.secret')).toBeNull()
    expect(parseHubToken('csk_ws1.')).toBeNull()
  })

  test('trims surrounding whitespace', () => {
    expect(parseHubToken('  csk_ws1.secret  ')).toEqual({ workspaceId: 'ws1', secret: 'secret' })
  })
})

describe('hubErrorMessage', () => {
  test('renders each error kind distinctly', () => {
    expect(hubErrorMessage({ kind: 'network' })).toContain('could not reach')
    expect(hubErrorMessage({ kind: 'unavailable' })).toContain('does not support')
    expect(hubErrorMessage({ kind: 'http', status: 409, error: 'ticket_in_flight' })).toContain(
      'ticket_in_flight',
    )
  })
})

describe('listTicketRequests', () => {
  test('parses a valid collection response', async () => {
    const calls: Call[] = []
    const result = await listTicketRequests(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { requests: [validRequest] }, calls),
    )
    expect(result).toEqual({ ok: true, data: [validRequest] })
    expect(calls[0]?.url).toContain('/api/cli/ticket-requests?')
    expect(calls[0]?.url).toContain('status=queued')
    expect(calls[0]?.init.method).toBe('GET')
    const headers = calls[0]?.init.headers as Record<string, string> | undefined
    expect(headers?.authorization).toBe('Bearer csk_w1.s1')
  })

  test('a 404 on this collection route degrades to unavailable, not a hard error', async () => {
    const result = await listTicketRequests(
      creds,
      'https://github.com/o/r.git',
      fetchStub(404, { error: 'not found' }, []),
    )
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable' } })
  })

  test('a network failure is reported as such', async () => {
    const result = await listTicketRequests(creds, 'https://github.com/o/r.git', fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })

  test('a 5xx carries its status and message', async () => {
    const result = await listTicketRequests(
      creds,
      'https://github.com/o/r.git',
      fetchStub(500, { error: 'db down' }, []),
    )
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 500, error: 'db down' } })
  })

  test('a malformed item refuses the whole list', async () => {
    const result = await listTicketRequests(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { requests: [{ nope: true }] }, []),
    )
    expect(result.ok).toBe(false)
  })
})

describe('claimTicketRequest', () => {
  test('parses the claimed request', async () => {
    const result = await claimTicketRequest(
      creds,
      'r1',
      fetchStub(200, { request: validRequest }, []),
    )
    expect(result).toEqual({ ok: true, data: validRequest })
  })

  test('a by-id 404 is a normal http error, not unavailable', async () => {
    const result = await claimTicketRequest(creds, 'missing', fetchStub(404, { error: 'gone' }, []))
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 404, error: 'gone' } })
  })
})

describe('submitTicketRequestTickets', () => {
  test('sends the wire shape and parses the created tickets', async () => {
    const calls: Call[] = []
    const result = await submitTicketRequestTickets(
      creds,
      'r1',
      [{ title: 'A', body: 'b', dependsOnIndex: 0 }],
      fetchStub(200, { tickets: [validTicket] }, calls),
    )
    expect(result).toEqual({ ok: true, data: [validTicket] })
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      tickets: { title: string; body: string; depends_on_index: number }[]
    }
    expect(body.tickets).toEqual([{ title: 'A', body: 'b', depends_on_index: 0 }])
  })
})

describe('failTicketRequest', () => {
  test('acknowledges success regardless of response body', async () => {
    const calls: Call[] = []
    const result = await failTicketRequest(creds, 'r1', 'lint failed', fetchStub(200, {}, calls))
    expect(result).toEqual({ ok: true, data: {} })
    const body = JSON.parse(String(calls[0]?.init.body)) as { error_message: string }
    expect(body.error_message).toBe('lint failed')
  })
})

describe('createTicket', () => {
  test('maps sourceIssue onto the wire shape', async () => {
    const calls: Call[] = []
    const result = await createTicket(
      creds,
      {
        remoteUrl: 'https://github.com/o/r.git',
        title: 'Add a thing',
        body: '**Context**\n\nx',
        sourceIssue: { iid: '42', url: 'https://github.com/o/r/issues/42' },
      },
      fetchStub(201, { ticket: validTicket }, calls),
    )
    expect(result).toEqual({ ok: true, data: validTicket })
    const body = JSON.parse(String(calls[0]?.init.body)) as { source_issue: unknown }
    expect(body.source_issue).toEqual({ iid: '42', url: 'https://github.com/o/r/issues/42' })
  })

  test('a 409 (issue already ticketed) is a normal http error', async () => {
    const result = await createTicket(
      creds,
      { remoteUrl: 'https://github.com/o/r.git', title: 't', body: 'b' },
      fetchStub(409, { error: 'already ticketed' }, []),
    )
    expect(result).toEqual({
      ok: false,
      error: { kind: 'http', status: 409, error: 'already ticketed' },
    })
  })
})

describe('listTickets / getTicket', () => {
  test('listTickets sends remote_url and status', async () => {
    const calls: Call[] = []
    await listTickets(
      creds,
      'https://github.com/o/r.git',
      'published',
      fetchStub(200, { tickets: [] }, calls),
    )
    expect(calls[0]?.url).toContain('status=published')
  })

  test('getTicket 404 is a normal not-found, never unavailable', async () => {
    const result = await getTicket(creds, 'missing', fetchStub(404, { error: 'not found' }, []))
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 404, error: 'not found' } })
  })
})

describe('listInFlightTickets', () => {
  test('sends status=in_flight and parses arm_local_status when present', async () => {
    const calls: Call[] = []
    const result = await listInFlightTickets(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { tickets: [{ ...validTicket, arm_local_status: 'executing' }] }, calls),
    )
    expect(calls[0]?.url).toContain('status=in_flight')
    expect(calls[0]?.url).toContain('remote_url=')
    expect(result).toEqual({ ok: true, data: [{ ...validTicket, arm_local_status: 'executing' }] })
  })

  test('degrades arm_local_status to null when the hub does not send it (older hub)', async () => {
    const result = await listInFlightTickets(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { tickets: [validTicket] }, []),
    )
    expect(result).toEqual({ ok: true, data: [{ ...validTicket, arm_local_status: null }] })
  })

  test('a blank arm_local_status also degrades to null', async () => {
    const result = await listInFlightTickets(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { tickets: [{ ...validTicket, arm_local_status: '   ' }] }, []),
    )
    expect(result).toEqual({ ok: true, data: [{ ...validTicket, arm_local_status: null }] })
  })

  test('a network failure is reported as such', async () => {
    const result = await listInFlightTickets(creds, 'https://github.com/o/r.git', fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })

  test('a malformed base ticket still refuses the whole list', async () => {
    const result = await listInFlightTickets(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { tickets: [{ nope: true }] }, []),
    )
    expect(result.ok).toBe(false)
  })
})

describe('claimTicket', () => {
  test('parses ticket + lease', async () => {
    const result = await claimTicket(
      creds,
      't1',
      {},
      fetchStub(200, { ticket: validTicket, lease_expires_at: '2026-01-01T00:05:00.000Z' }, []),
    )
    expect(result).toEqual({
      ok: true,
      data: { ticket: validTicket, lease_expires_at: '2026-01-01T00:05:00.000Z' },
    })
  })

  test('409 ticket_in_flight surfaces as an http error the caller can special-case', async () => {
    const result = await claimTicket(
      creds,
      't1',
      {},
      fetchStub(409, { error: 'ticket_in_flight' }, []),
    )
    expect(result).toEqual({
      ok: false,
      error: { kind: 'http', status: 409, error: 'ticket_in_flight' },
    })
  })
})

describe('heartbeat / transition / pushEvents', () => {
  test('heartbeat acknowledges on 200 with no body needed', async () => {
    const result = await heartbeat(creds, 't1', fetchStub(200, {}, []))
    expect(result).toEqual({ ok: true, data: {} })
  })

  test('transition sends the ArmTransition verbatim', async () => {
    const calls: Call[] = []
    await transition(
      creds,
      't1',
      {
        type: 'merged',
        merge_sha: 'a1b2c3d4e5',
        idempotency_key: 'k1',
        at: '2026-01-01T00:00:00.000Z',
      },
      fetchStub(200, {}, calls),
    )
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body).toEqual({
      type: 'merged',
      merge_sha: 'a1b2c3d4e5',
      idempotency_key: 'k1',
      at: '2026-01-01T00:00:00.000Z',
    })
  })

  test('pushEvents sends run/ticket ids and the event batch', async () => {
    const calls: Call[] = []
    await pushEvents(
      creds,
      {
        remoteUrl: 'https://github.com/o/r.git',
        runId: 'run1',
        ticketId: 't1',
        events: [{ run_id: 'run1', at: '2026-01-01T00:00:00.000Z', event_type: 'x', label: 'x' }],
      },
      fetchStub(200, {}, calls),
    )
    const body = JSON.parse(String(calls[0]?.init.body)) as { run_id: string; ticket_id: string }
    expect(body.run_id).toBe('run1')
    expect(body.ticket_id).toBe('t1')
  })
})

describe('registerRunnerKey', () => {
  test('sends the public key and name, parses the fingerprint back', async () => {
    const calls: Call[] = []
    const result = await registerRunnerKey(
      creds,
      { public_key: 'pk1', name: 'my-laptop' },
      fetchStub(200, { fingerprint: 'fp1' }, calls),
    )
    expect(result).toEqual({ ok: true, data: { fingerprint: 'fp1' } })
    const body = JSON.parse(String(calls[0]?.init.body)) as { public_key: string; name: string }
    expect(body).toEqual({ public_key: 'pk1', name: 'my-laptop' })
  })

  test('a malformed response is refused', async () => {
    const result = await registerRunnerKey(
      creds,
      { public_key: 'pk1', name: 'my-laptop' },
      fetchStub(200, {}, []),
    )
    expect(result.ok).toBe(false)
  })
})

describe('listRunners', () => {
  test('parses a valid collection response', async () => {
    const calls: Call[] = []
    const result = await listRunners(
      creds,
      fetchStub(200, { runners: [validRunnerListEntry] }, calls),
    )
    expect(result).toEqual({ ok: true, data: [validRunnerListEntry] })
    expect(calls[0]?.url).toBe('https://hub.example/api/cli/runners')
    expect(calls[0]?.init.method).toBe('GET')
  })

  /**
   * The one place this file's list* behavior intentionally diverges from
   * `sanitizeList`'s all-or-nothing doctrine: a malformed row is dropped,
   * the rest of the listing still comes back `ok: true`.
   */
  test('drops an invalid entry instead of refusing the whole list', async () => {
    const result = await listRunners(
      creds,
      fetchStub(200, { runners: [validRunnerListEntry, { nope: true }] }, []),
    )
    expect(result).toEqual({ ok: true, data: [validRunnerListEntry] })
  })

  test('a 404 on this collection route degrades to unavailable', async () => {
    const result = await listRunners(creds, fetchStub(404, { error: 'not found' }, []))
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable' } })
  })

  test('a network failure is reported as such', async () => {
    const result = await listRunners(creds, fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})

describe('depositRunnerSecret', () => {
  test('sends the ciphertext to the fingerprint-scoped route', async () => {
    const calls: Call[] = []
    const result = await depositRunnerSecret(
      creds,
      'fp1',
      'ciphertext-blob',
      fetchStub(200, {}, calls),
    )
    expect(result).toEqual({ ok: true, data: undefined })
    expect(calls[0]?.url).toBe('https://hub.example/api/cli/runners/fp1/secret')
    const body = JSON.parse(String(calls[0]?.init.body)) as { ciphertext: string }
    expect(body).toEqual({ ciphertext: 'ciphertext-blob' })
  })

  test('a by-id 404 is a normal http error, not unavailable', async () => {
    const result = await depositRunnerSecret(
      creds,
      'unknown-fp',
      'blob',
      fetchStub(404, { error: 'unknown runner' }, []),
    )
    expect(result).toEqual({
      ok: false,
      error: { kind: 'http', status: 404, error: 'unknown runner' },
    })
  })
})

describe('claimPendingSecret', () => {
  test('parses the claimed ciphertext', async () => {
    const result = await claimPendingSecret(
      creds,
      'fp1',
      fetchStub(
        200,
        { secret: { ciphertext: 'sealed-blob', pushed_at: '2026-01-01T00:00:00.000Z' } },
        [],
      ),
    )
    expect(result).toEqual({ ok: true, data: { ciphertext: 'sealed-blob' } })
  })

  test('a 404 (nothing pending) resolves as ok(null), not an error', async () => {
    const result = await claimPendingSecret(creds, 'fp1', fetchStub(404, { error: 'none' }, []))
    expect(result).toEqual({ ok: true, data: null })
  })

  test('a malformed secret body is refused', async () => {
    const result = await claimPendingSecret(
      creds,
      'fp1',
      fetchStub(200, { secret: { nope: true } }, []),
    )
    expect(result.ok).toBe(false)
  })

  test('a network failure is reported as such', async () => {
    const result = await claimPendingSecret(creds, 'fp1', fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})

/**
 * Isolated via `CODESEMA_CONFIG_DIR` (same pattern as runner-daemon.test.ts),
 * never via module mocking: a `mock.module` override of `./runner-identity.js`
 * is process-wide and, under the project's parallel test runner, was
 * observed leaking into runner-identity.test.ts's own suite running
 * concurrently in another file. A real, isolated identity file exercises the
 * same `request()` code path without that risk.
 */
describe('runner identity header propagation', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-hubclient-identity-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
  })

  test('sends no runner header when no identity exists yet', async () => {
    const calls: Call[] = []
    await listTicketRequests(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { requests: [] }, calls),
    )
    const headers = calls[0]?.init.headers as Record<string, string> | undefined
    expect(headers?.['x-codesema-runner']).toBeUndefined()
  })

  test('adds x-codesema-runner to every request once an identity exists', async () => {
    const identity = loadOrCreateRunnerIdentity()
    const calls: Call[] = []
    await listTicketRequests(
      creds,
      'https://github.com/o/r.git',
      fetchStub(200, { requests: [] }, calls),
    )
    const headers = calls[0]?.init.headers as Record<string, string> | undefined
    expect(headers?.['x-codesema-runner']).toBe(identity.fingerprint)
  })
})

describe('verification', () => {
  test('posts to the ticket-scoped route and parses id + created', async () => {
    const calls: Call[] = []
    const result = await verification(
      creds,
      't1',
      { ...validVerification, idempotency_key: 't1:verify:1' },
      fetchStub(200, { id: 'v1', created: true }, calls),
    )
    expect(result).toEqual({ ok: true, data: { id: 'v1', created: true } })
    expect(calls[0]?.url).toBe('https://hub.example/api/cli/tickets/t1/verification')
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.status).toBe('passed')
    expect(body.idempotency_key).toBe('t1:verify:1')
  })

  test('encodes the ticket id in the path', async () => {
    const calls: Call[] = []
    await verification(
      creds,
      't 1/weird',
      { ...validVerification, idempotency_key: 'k' },
      fetchStub(200, { id: 'v1', created: false }, calls),
    )
    expect(calls[0]?.url).toBe('https://hub.example/api/cli/tickets/t%201%2Fweird/verification')
  })

  test('a malformed response body is refused', async () => {
    const result = await verification(
      creds,
      't1',
      { ...validVerification, idempotency_key: 'k' },
      fetchStub(200, { id: 'v1' }, []),
    )
    expect(result.ok).toBe(false)
  })

  test('a 5xx carries its status and message', async () => {
    const result = await verification(
      creds,
      't1',
      { ...validVerification, idempotency_key: 'k' },
      fetchStub(500, { error: 'db down' }, []),
    )
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 500, error: 'db down' } })
  })

  test('a network failure is reported as such', async () => {
    const result = await verification(
      creds,
      't1',
      { ...validVerification, idempotency_key: 'k' },
      fetchOffline(),
    )
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})

describe('listRunbookScans', () => {
  test('parses a valid collection response', async () => {
    const calls: Call[] = []
    const result = await listRunbookScans(
      creds,
      fetchStub(200, { scans: [validRunbookScan] }, calls),
    )
    expect(result).toEqual({ ok: true, data: [validRunbookScan] })
    expect(calls[0]?.url).toBe('https://hub.example/api/cli/runbook-scans')
    expect(calls[0]?.init.method).toBe('GET')
  })

  test('a malformed item is dropped, not refusing the whole list', async () => {
    const result = await listRunbookScans(
      creds,
      fetchStub(200, { scans: [validRunbookScan, { nope: true }] }, []),
    )
    expect(result).toEqual({ ok: true, data: [validRunbookScan] })
  })

  test('a 404 on this collection route degrades to unavailable, not a hard error', async () => {
    const result = await listRunbookScans(creds, fetchStub(404, { error: 'not found' }, []))
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable' } })
  })

  test('a network failure is reported as such', async () => {
    const result = await listRunbookScans(creds, fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})

describe('claimRunbookScan', () => {
  test('parses the claimed scan and its lease', async () => {
    const result = await claimRunbookScan(
      creds,
      validRunbookScan.id,
      {},
      fetchStub(200, { scan: validRunbookScan, lease_expires_at: '2026-01-01T00:05:00.000Z' }, []),
    )
    expect(result).toEqual({
      ok: true,
      data: { scan: validRunbookScan, lease_expires_at: '2026-01-01T00:05:00.000Z' },
    })
  })

  test('sends lease_seconds only when given', async () => {
    const calls: Call[] = []
    await claimRunbookScan(
      creds,
      validRunbookScan.id,
      { leaseSeconds: 120 },
      fetchStub(
        200,
        { scan: validRunbookScan, lease_expires_at: '2026-01-01T00:05:00.000Z' },
        calls,
      ),
    )
    const body = JSON.parse(String(calls[0]?.init.body)) as { lease_seconds: number }
    expect(body.lease_seconds).toBe(120)
  })

  test('a by-id 404 is a normal http error, not unavailable', async () => {
    const result = await claimRunbookScan(
      creds,
      'missing',
      {},
      fetchStub(404, { error: 'gone' }, []),
    )
    expect(result).toEqual({ ok: false, error: { kind: 'http', status: 404, error: 'gone' } })
  })

  test('a malformed response body is refused', async () => {
    const result = await claimRunbookScan(
      creds,
      validRunbookScan.id,
      {},
      fetchStub(200, { scan: validRunbookScan }, []),
    )
    expect(result.ok).toBe(false)
  })
})

describe('reportRunbookScanResult', () => {
  test('sends the runbook and validation, parses the ack', async () => {
    const calls: Call[] = []
    const result = await reportRunbookScanResult(
      creds,
      validRunbookScan.id,
      { runbook: validRunbook, validation: validRunbookValidation, log_tail: 'all green' },
      fetchStub(200, { runbook_id: 'rb1', already_recorded: false }, calls),
    )
    expect(result).toEqual({ ok: true, data: { runbook_id: 'rb1', already_recorded: false } })
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.runbook).toEqual(validRunbook)
    expect(body.validation).toEqual(validRunbookValidation)
    expect(body.log_tail).toBe('all green')
  })

  test('a malformed response body is refused', async () => {
    const result = await reportRunbookScanResult(
      creds,
      validRunbookScan.id,
      { runbook: validRunbook, validation: validRunbookValidation },
      fetchStub(200, { runbook_id: 'rb1' }, []),
    )
    expect(result.ok).toBe(false)
  })

  test('a network failure is reported as such', async () => {
    const result = await reportRunbookScanResult(
      creds,
      validRunbookScan.id,
      { runbook: validRunbook, validation: validRunbookValidation },
      fetchOffline(),
    )
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})

describe('failRunbookScan', () => {
  test('sends the error and acknowledges', async () => {
    const calls: Call[] = []
    const result = await failRunbookScan(
      creds,
      validRunbookScan.id,
      { error: 'no /dev/kvm' },
      fetchStub(200, {}, calls),
    )
    expect(result).toEqual({ ok: true, data: {} })
    const body = JSON.parse(String(calls[0]?.init.body)) as { error: string }
    expect(body).toEqual({ error: 'no /dev/kvm' })
  })

  test('a network failure is reported as such', async () => {
    const result = await failRunbookScan(creds, validRunbookScan.id, { error: 'x' }, fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})

describe('currentRunbook', () => {
  test('parses both the runbook and its validation', async () => {
    const result = await currentRunbook(
      creds,
      'repo1',
      fetchStub(200, { runbook: validRunbook, validation: validRunbookValidation }, []),
    )
    expect(result).toEqual({
      ok: true,
      data: { runbook: validRunbook, validation: validRunbookValidation },
    })
  })

  test('a repository with no runbook yet parses as both null', async () => {
    const result = await currentRunbook(
      creds,
      'repo1',
      fetchStub(200, { runbook: null, validation: null }, []),
    )
    expect(result).toEqual({ ok: true, data: { runbook: null, validation: null } })
  })

  test('a malformed runbook refuses the whole response', async () => {
    const result = await currentRunbook(
      creds,
      'repo1',
      fetchStub(200, { runbook: { nope: true }, validation: null }, []),
    )
    expect(result.ok).toBe(false)
  })

  test('a malformed validation refuses the whole response, even with a valid runbook', async () => {
    const result = await currentRunbook(
      creds,
      'repo1',
      fetchStub(200, { runbook: validRunbook, validation: { nope: true } }, []),
    )
    expect(result.ok).toBe(false)
  })

  test('encodes the repo id in the path', async () => {
    const calls: Call[] = []
    await currentRunbook(
      creds,
      'repo 1/weird',
      fetchStub(200, { runbook: null, validation: null }, calls),
    )
    expect(calls[0]?.url).toBe('https://hub.example/api/cli/repos/repo%201%2Fweird/runbook')
  })

  test('a network failure is reported as such', async () => {
    const result = await currentRunbook(creds, 'repo1', fetchOffline())
    expect(result).toEqual({ ok: false, error: { kind: 'network' } })
  })
})
