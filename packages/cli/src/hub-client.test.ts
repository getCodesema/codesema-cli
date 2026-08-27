import { describe, expect, test } from 'bun:test'
import type { ArmTicket, ArmTicketRequest } from './contract.js'
import {
  claimTicket,
  claimTicketRequest,
  createTicket,
  failTicketRequest,
  getTicket,
  heartbeat,
  hubErrorMessage,
  listInFlightTickets,
  listTicketRequests,
  listTickets,
  parseHubToken,
  pushEvents,
  submitTicketRequestTickets,
  transition,
} from './hub-client.js'
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
      { type: 'merged', idempotency_key: 'k1', at: '2026-01-01T00:00:00.000Z' },
      fetchStub(200, {}, calls),
    )
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      type: string
      idempotency_key: string
      at: string
    }
    expect(body).toEqual({ type: 'merged', idempotency_key: 'k1', at: '2026-01-01T00:00:00.000Z' })
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
