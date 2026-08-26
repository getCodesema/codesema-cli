import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import {
  draftAndPublishTicket,
  draftAndSubmitTicketRequest,
  draftTicketBody,
} from './brain-draft.js'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ArmTicket, ArmTicketRequest } from './contract.js'

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

function initRepo(cwd: string, remoteUrl?: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'chore: init'], { cwd })
  if (remoteUrl) {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd })
  }
}

const VALID_BODY = `**Context**

Some context.

**Goal**

Some goal.

**Scope**

packages/x.

**Acceptance criteria**

- WHEN a THE SYSTEM SHALL b
- WHEN c THE SYSTEM SHALL d
- WHEN e THE SYSTEM SHALL f

**Out of scope**

Nothing else.`

const INVALID_BODY = 'not a ticket at all'

const validTicket: ArmTicket = {
  id: 't1',
  repo_remote_url: 'https://github.com/o/r.git',
  title: 'Add a thing',
  body: VALID_BODY,
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

function runAgentSequence(outputs: string[]): {
  fn: (opts: AgentRunOptions) => Promise<string>
  calls: AgentRunOptions[]
} {
  const calls: AgentRunOptions[] = []
  let i = 0
  return {
    calls,
    fn: async (opts: AgentRunOptions) => {
      calls.push(opts)
      const out = outputs[Math.min(i, outputs.length - 1)] ?? ''
      i++
      return out
    },
  }
}

describe('brain-draft', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-draft-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-draft-repo-'))
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

  describe('draftTicketBody', () => {
    test('accepts a conforming body on the first attempt when the title is already known', async () => {
      const agent = runAgentSequence([VALID_BODY])
      const result = await draftTicketBody(
        { cwd, title: 'Known title', promptContext: 'do the thing' },
        { runAgentFn: agent.fn },
      )
      expect(result).toEqual({ ok: true, title: 'Known title', body: VALID_BODY })
      expect(agent.calls.length).toBe(1)
      expect(agent.calls[0]?.absoluteCapMs).toBe(5 * 60_000)
    })

    test('extracts a TITLE line and the body when no title is known', async () => {
      const agent = runAgentSequence([`TITLE: A derived title\n\n${VALID_BODY}`])
      const result = await draftTicketBody(
        { cwd, promptContext: 'do the thing' },
        { runAgentFn: agent.fn },
      )
      expect(result).toEqual({ ok: true, title: 'A derived title', body: VALID_BODY })
    })

    test('extracts the body even behind agent preamble, from the first heading onward', async () => {
      const agent = runAgentSequence([`Sure, here it is:\n\n${VALID_BODY}`])
      const result = await draftTicketBody(
        { cwd, title: 'T', promptContext: 'x' },
        { runAgentFn: agent.fn },
      )
      expect(result).toEqual({ ok: true, title: 'T', body: VALID_BODY })
    })

    test('retries once with the lint problems folded into the prompt, then succeeds', async () => {
      const agent = runAgentSequence([INVALID_BODY, VALID_BODY])
      const result = await draftTicketBody(
        { cwd, title: 'T', promptContext: 'x' },
        { runAgentFn: agent.fn },
      )
      expect(result).toEqual({ ok: true, title: 'T', body: VALID_BODY })
      expect(agent.calls.length).toBe(2)
      expect(agent.calls[1]?.prompt).toContain('rejected')
    })

    test('gives up after the retry is also rejected, naming the reasons', async () => {
      const agent = runAgentSequence([INVALID_BODY, INVALID_BODY])
      const result = await draftTicketBody(
        { cwd, title: 'T', promptContext: 'x' },
        { runAgentFn: agent.fn },
      )
      expect(result.ok).toBe(false)
      expect(agent.calls.length).toBe(2)
      if (!result.ok) {
        expect(result.reason).toContain('could not produce a conforming ticket')
      }
    })

    test('a drafting agent that throws fails immediately, no retry', async () => {
      const agent = { fn: async (): Promise<string> => Promise.reject(new Error('boom')) }
      const result = await draftTicketBody(
        { cwd, title: 'T', promptContext: 'x' },
        { runAgentFn: agent.fn },
      )
      expect(result).toEqual({ ok: false, reason: 'drafting agent failed: boom' })
    })

    test('missing the TITLE line when no title is known fails after both attempts', async () => {
      const agent = runAgentSequence([VALID_BODY])
      const result = await draftTicketBody({ cwd, promptContext: 'x' }, { runAgentFn: agent.fn })
      expect(result.ok).toBe(false)
      expect(agent.calls.length).toBe(2)
    })
  })

  describe('draftAndPublishTicket', () => {
    test('fails fast when no brain is connected', async () => {
      const result = await draftAndPublishTicket({ kind: 'prompt', cwd, title: 'T', prompt: 'x' })
      expect(result).toEqual({
        ok: false,
        reason: 'not connected to a brain: run `codesema brain connect` first',
      })
    })

    test('fails fast when the repo has no origin remote', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd)
      const result = await draftAndPublishTicket({ kind: 'prompt', cwd, title: 'T', prompt: 'x' })
      expect(result).toEqual({ ok: false, reason: 'this workspace has no git origin remote' })
    })

    test('drafts then publishes with POST /tickets, from a free-form prompt', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const agent = runAgentSequence([VALID_BODY])
      const calls: Call[] = []
      const result = await draftAndPublishTicket(
        { kind: 'prompt', cwd, title: 'Add a thing', prompt: 'do the thing' },
        { runAgentFn: agent.fn, fetchImpl: fetchStub(201, { ticket: validTicket }, calls) },
      )
      expect(result).toEqual({ ok: true, ticket: validTicket })
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/tickets')
      const body = JSON.parse(String(calls[0]?.init.body)) as { title: string; remote_url: string }
      expect(body.title).toBe('Add a thing')
      expect(body.remote_url).toBe('https://github.com/o/r.git')
    })

    test('surfaces a publish rejection (e.g. lint refused server-side) as a reason', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const agent = runAgentSequence([VALID_BODY])
      const result = await draftAndPublishTicket(
        { kind: 'prompt', cwd, title: 'T', prompt: 'x' },
        { runAgentFn: agent.fn, fetchImpl: fetchStub(400, { error: 'bad body' }, []) },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('bad body')
      }
    })
  })

  describe('draftAndSubmitTicketRequest', () => {
    const request: ArmTicketRequest = {
      id: 'req1',
      repo_remote_url: 'https://github.com/o/r.git',
      prompt: 'add a thing',
      status: 'queued',
      source_issue: null,
      created_at: '2026-01-01T00:00:00.000Z',
    }

    test('drafts a title and body from the bare prompt, then submits one ticket', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      const agent = runAgentSequence([`TITLE: Derived title\n\n${VALID_BODY}`])
      const calls: Call[] = []
      const result = await draftAndSubmitTicketRequest(request, cwd, {
        runAgentFn: agent.fn,
        fetchImpl: fetchStub(200, { tickets: [validTicket] }, calls),
      })
      expect(result).toEqual({ ok: true, tickets: [validTicket] })
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/ticket-requests/req1/tickets')
      const body = JSON.parse(String(calls[0]?.init.body)) as {
        tickets: { title: string; body: string }[]
      }
      expect(body.tickets).toEqual([{ title: 'Derived title', body: VALID_BODY }])
    })

    test('a drafting failure calls failTicketRequest with the reason and reports it', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      const agent = runAgentSequence([INVALID_BODY, INVALID_BODY])
      const calls: Call[] = []
      const result = await draftAndSubmitTicketRequest(request, cwd, {
        runAgentFn: agent.fn,
        fetchImpl: fetchStub(200, {}, calls),
      })
      expect(result.ok).toBe(false)
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/ticket-requests/req1/fail')
      const body = JSON.parse(String(calls[0]?.init.body)) as { error_message: string }
      expect(body.error_message).toBeTruthy()
    })

    test('not connected fails without ever calling the agent', async () => {
      const agent = runAgentSequence([VALID_BODY])
      const result = await draftAndSubmitTicketRequest(request, cwd, { runAgentFn: agent.fn })
      expect(result).toEqual({ ok: false, reason: 'not connected to a brain' })
      expect(agent.calls.length).toBe(0)
    })
  })
})
