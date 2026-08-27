import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ArmTicket } from './contract.js'
import { addProject, type Project } from './projects.js'
import { createHubTicketTask, resolveHubTicketOrigin } from './task-hub-ticket.js'
import type { TaskActionResult, TaskRunner, TaskRunnerOptions } from './task-runner.js'
import { createTaskManager } from './task-server.js'
import { listTasks, readTaskEvents } from './tasks-store.js'

// --- rigs, on the exact patron of task-server.test.ts ----------------------

let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
const cleanups: string[] = []

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codesema-hub-ticket-cfg-'))
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

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-hub-ticket-'))
  cleanups.push(dir)
  return dir
}

/** Real git repo: projects must be git roots. */
function makeRepo(): string {
  const repo = makeDir()
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

function register(repo: string): Project {
  const added = addProject(repo)
  if (!added.ok) {
    throw new Error(added.error)
  }
  return added.project
}

/** Captures the manager→runner seam without ever launching an agent. */
function fakeRunner(): { createRunnerFn: (options: TaskRunnerOptions) => TaskRunner } {
  return {
    createRunnerFn: () => ({
      start: (): TaskActionResult => ({ ok: true }),
      reply: (): TaskActionResult => ({ ok: false, code: 409, error: 'not waiting for a reply' }),
      resume: (): TaskActionResult => ({ ok: true }),
      interrupt: (): TaskActionResult => ({ ok: true }),
      abandon: () => Promise.resolve({ ok: true as const }),
      isAbandoning: () => false,
      attach: () => Promise.resolve({ ok: true as const }),
      shutdown: () => Promise.resolve(),
      runningCount: () => 0,
    }),
  }
}

const managerOpts = { command: 'claude -p', timeoutMs: 1000 }

// --- a valid ticket body: five headings, three EARS criteria ---------------

const VALID_BODY = `**Context**
The onboarding flow drops new users who close the tab mid-way.

**Goal**
Persist onboarding progress so it resumes where it left off.

**Scope**
The onboarding wizard's client-side state only.

**Acceptance criteria**
- WHEN a user closes the tab mid-onboarding THE SYSTEM SHALL persist their progress
- WHEN a user reopens the onboarding wizard THE SYSTEM SHALL resume from the saved step
- WHEN onboarding completes THE SYSTEM SHALL clear the saved progress

**Out of scope**
Server-side onboarding analytics.`

function fakeTicket(overrides: Partial<ArmTicket> = {}): ArmTicket {
  return {
    id: 'tkt-1',
    repo_remote_url: '',
    title: 'Persist onboarding progress',
    body: VALID_BODY,
    status: 'in_progress',
    depends_on: null,
    executed_by: null,
    lease_expires_at: null,
    issue: null,
    branch: null,
    mr_iid: null,
    mr_url: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('resolveHubTicketOrigin', () => {
  test('a valid ticket resolves title, prompt, criteria and hubTicket', () => {
    const origin = resolveHubTicketOrigin('/repo', fakeTicket())
    expect(origin.ok).toBe(true)
    if (!origin.ok) {
      return
    }
    expect(origin.title).toBe('Persist onboarding progress')
    expect(origin.prompt).toBe(VALID_BODY)
    expect(origin.criteria.length).toBe(3)
    expect(origin.criteria.every((c) => c.id.startsWith('ac-'))).toBe(true)
    expect(origin.hubTicket).toEqual({ id: 'tkt-1', title: 'Persist onboarding progress' })
    expect(origin.issue).toBeNull()
    expect(origin.issueSnapshot).toBeNull()
    expect(origin.coverageGap).toBe(false)
  })

  test('an empty title refuses', () => {
    const origin = resolveHubTicketOrigin('/repo', fakeTicket({ title: '   ' }))
    expect(origin.ok).toBe(false)
    if (origin.ok) {
      return
    }
    expect(origin.refusal.code).toBe(400)
    expect(origin.refusal.error).toBe('empty title')
  })

  test('a body that fails T2.3 lint refuses, naming the problem', () => {
    const origin = resolveHubTicketOrigin('/repo', fakeTicket({ body: 'not a ticket at all' }))
    expect(origin.ok).toBe(false)
    if (origin.ok) {
      return
    }
    expect(origin.refusal.code).toBe(400)
    expect(origin.refusal.error).toContain('missing section')
  })

  test('a body with fewer than three criteria refuses', () => {
    const shortBody = VALID_BODY.replace(
      /\*\*Acceptance criteria\*\*[\s\S]*?\n\n\*\*Out of scope\*\*/,
      '**Acceptance criteria**\n- WHEN a user closes the tab THE SYSTEM SHALL persist progress\n\n**Out of scope**',
    )
    const origin = resolveHubTicketOrigin('/repo', fakeTicket({ body: shortBody }))
    expect(origin.ok).toBe(false)
    if (origin.ok) {
      return
    }
    expect(origin.refusal.error).toContain('at least 3')
  })

  test('hubTicket.url prefers mr_url over the source issue url', () => {
    const origin = resolveHubTicketOrigin(
      '/repo',
      fakeTicket({
        mr_url: 'https://forge.example/mr/1',
        issue: { iid: '42', url: 'https://forge.example/issues/42' },
      }),
    )
    expect(origin.ok).toBe(true)
    if (!origin.ok) {
      return
    }
    expect(origin.hubTicket.url).toBe('https://forge.example/mr/1')
  })

  test('hubTicket.url falls back to the source issue url when there is no mr_url', () => {
    const origin = resolveHubTicketOrigin(
      '/repo',
      fakeTicket({ mr_url: null, issue: { iid: '42', url: 'https://forge.example/issues/42' } }),
    )
    expect(origin.ok).toBe(true)
    if (!origin.ok) {
      return
    }
    expect(origin.hubTicket.url).toBe('https://forge.example/issues/42')
  })

  test('no mr_url and no source issue: hubTicket carries no url at all', () => {
    const origin = resolveHubTicketOrigin('/repo', fakeTicket())
    expect(origin.ok).toBe(true)
    if (!origin.ok) {
      return
    }
    expect('url' in origin.hubTicket).toBe(false)
  })
})

describe('createHubTicketTask', () => {
  test('a valid ticket creates a queued task with the right title, criteria and hub_ticket', async () => {
    const repo = makeRepo()
    const project = register(repo)
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })

    const created = await createHubTicketTask(manager, project.path, fakeTicket())

    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    expect(created.record.status).toBe('queued')
    expect(created.record.title).toBe('Persist onboarding progress')
    expect(created.record.auto_ship).toBe(true)
    expect(created.record.criteria?.length).toBe(3)
    expect(created.record.hub_ticket).toEqual({
      id: 'tkt-1',
      title: 'Persist onboarding progress',
    })

    // On disk, not just in the in-memory return value.
    const onDisk = listTasks(project.path).find((t) => t.id === created.record.id)
    expect(onDisk?.criteria?.length).toBe(3)
    expect(onDisk?.hub_ticket?.id).toBe('tkt-1')

    // The criteria landed with a journal line, same as a human validation would.
    const events = readTaskEvents(project.path, created.record.id)
    expect(events.some((e) => e.type === 'criteria' && e.data.name === 'validated')).toBe(true)
  })

  test('an invalid ticket body refuses without creating a task', async () => {
    const repo = makeRepo()
    const project = register(repo)
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })

    const created = await createHubTicketTask(
      manager,
      project.path,
      fakeTicket({ body: 'not a ticket at all' }),
    )

    expect(created.ok).toBe(false)
    if (created.ok) {
      return
    }
    expect(created.code).toBe(400)
    expect(listTasks(project.path)).toEqual([])
  })

  test('a repo that was never registered refuses with 404', async () => {
    const repo = makeRepo()
    // Deliberately not registered.
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })

    const created = await createHubTicketTask(manager, repo, fakeTicket())

    expect(created.ok).toBe(false)
    if (created.ok) {
      return
    }
    expect(created.code).toBe(404)
  })
})
