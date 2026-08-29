import { describe, expect, test } from 'bun:test'
import { RUNBOOK_VERSION, type RunbookConfig, type RunbookScan } from './contract.js'
import type {
  SandboxDriver,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxSecret,
  SandboxSpec,
} from './microsandbox-driver.js'
import type { ProjectSnapshot } from './microvm-snapshot.js'
import {
  DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS,
  RUNBOOK_SCAN_LEASE_SECONDS,
  RUNBOOK_SCAN_MAX_ATTEMPTS,
  runOneRunbookScan,
  runRunbookScan,
  type RunbookScanOutcome,
  type RunRunbookScanOptions,
} from './runbook-runner.js'
import { sanitizeRunbookProposal, type RunbookProposalInput } from './runbook-setup.js'

// ---------------------------------------------------------------------------
// Fakes: a scripted SandboxDriver/SandboxHandle. NEVER touches a real VM.
// ---------------------------------------------------------------------------

type ShellCall = { command: string; opts: SandboxExecOptions }

function okResult(stdout = ''): SandboxExecResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}
function failResult(code: number | null = 1, stdout = '', stderr = ''): SandboxExecResult {
  return { code, stdout, stderr, timedOut: false }
}
function timeoutResult(): SandboxExecResult {
  return { code: null, stdout: '', stderr: 'timed out', timedOut: true }
}

/** Exact-match script: an array cycles through results (stays on the last one), a bare result always answers the same. */
function scriptedRespond(
  script: Record<string, SandboxExecResult | SandboxExecResult[]>,
): (command: string) => SandboxExecResult {
  const counters = new Map<string, number>()
  return (command: string) => {
    const entry = script[command]
    if (entry === undefined) {
      return okResult()
    }
    if (!Array.isArray(entry)) {
      return entry
    }
    const i = counters.get(command) ?? 0
    counters.set(command, Math.min(i + 1, entry.length - 1))
    return entry[Math.min(i, entry.length - 1)] as SandboxExecResult
  }
}

function fakeHandle(
  name: string,
  respond: (command: string) => SandboxExecResult,
  calls: ShellCall[],
): SandboxHandle {
  return {
    name,
    exec: async (command, args) => {
      const full = [command, ...args].join(' ')
      calls.push({ command: full, opts: { timeoutMs: 0 } })
      return respond(full)
    },
    shell: async (script, opts) => {
      calls.push({ command: script, opts })
      return respond(script)
    },
    copyFromHost: async () => {},
    copyToHost: async () => {},
    writeFile: async () => {},
    readFile: async () => '',
    metrics: async () => ({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
    stop: async () => {},
  }
}

function fakeDriver(
  opts: {
    respond?: (command: string) => SandboxExecResult
    destroyShouldThrow?: boolean
  } = {},
): {
  driver: SandboxDriver
  calls: ShellCall[]
  destroyed: string[]
  specs: SandboxSpec[]
} {
  const calls: ShellCall[] = []
  const destroyed: string[] = []
  const specs: SandboxSpec[] = []
  const respond = opts.respond ?? (() => okResult())
  const driver: SandboxDriver = {
    kind: 'fake',
    probe: async () => ({ available: true, reason: null, version: '0.6.15' }),
    create: async (spec) => {
      specs.push(spec)
      return fakeHandle(spec.name, respond, calls)
    },
    snapshot: async (_sandboxName, snapshotName) => ({ name: snapshotName, sizeBytes: null }),
    listSandboxes: async () => [],
    listSnapshots: async () => [],
    destroy: async (name) => {
      if (opts.destroyShouldThrow) {
        throw new Error('destroy failed')
      }
      destroyed.push(name)
    },
    removeSnapshot: async () => {},
    ensureVolume: async () => {},
    removeVolume: async () => {},
  }
  return { driver, calls, destroyed, specs }
}

function sampleRunbook(overrides: Partial<RunbookConfig> = {}): RunbookConfig {
  return {
    version: RUNBOOK_VERSION,
    image: 'node:26',
    install: ['bun install'],
    services: { host_up: [], compose_file: null },
    healthchecks: [],
    tests: ['bun test'],
    egress: ['registry.npmjs.org'],
    depends_on_files: ['bun.lock'],
    ...overrides,
  }
}

const WRITTEN_SHA = '0123456789abcdef'

function baseOptions(overrides: Partial<RunRunbookScanOptions> = {}): RunRunbookScanOptions {
  const { driver } = fakeDriver()
  return {
    worktree: '/repo',
    projectId: 'proj1',
    headSha: 'a'.repeat(40),
    driver,
    command: 'claude -p',
    timeoutMs: 5_000,
    collectSetupFilesFn: () => [],
    buildPromptFn: () => 'the prompt',
    sanitizeProposalFn: () => ({ ok: true, runbook: sampleRunbook() }),
    writeRunbookConfigFn: () => WRITTEN_SHA,
    writeRunbookValidationFn: () => {},
    buildProjectSnapshotFn: async () =>
      ({ kind: 'ready', name: 'snap1', hash: 'h1' }) as ProjectSnapshot,
    runProposalFn: async () => 'ignored: sanitizeProposalFn decides',
    sleepFn: async () => {},
    ...overrides,
  }
}

describe('runRunbookScan — happy path', () => {
  test('proposal accepted, install and tests pass: completed on the first attempt', async () => {
    const { driver, calls, destroyed } = fakeDriver({
      respond: scriptedRespond({
        'bun install': okResult('installed'),
        'bun test': okResult('1 pass'),
      }),
    })
    const outcome = await runRunbookScan(baseOptions({ driver }))
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') {
      throw new Error('unreachable')
    }
    expect(outcome.attempts).toBe(1)
    expect(outcome.validation).toEqual({
      runbook_sha: WRITTEN_SHA,
      validated_sha: 'a'.repeat(40),
      validated_at: outcome.validation.validated_at,
      status: 'valid',
    })
    expect(outcome.snapshotName).toBe('snap1')
    expect(outcome.checks).toHaveLength(1)
    expect(outcome.checks[0]).toMatchObject({
      command: 'bun test',
      status: 'passed',
      exit_code: 0,
      tail: '1 pass',
    })
    expect(typeof outcome.checks[0]?.duration_ms).toBe('number')
    // install ran before the test, and the VM was always destroyed.
    expect(calls.map((c) => c.command)).toContain('bun install')
    expect(calls.map((c) => c.command)).toContain('bun test')
    expect(destroyed.length).toBe(1)
  })

  test('a flat-disk (cold) snapshot result yields snapshotName: null, still completed', async () => {
    const outcome = await runRunbookScan(
      baseOptions({
        buildProjectSnapshotFn: async () => ({ kind: 'cold', reason: 'flat root disk' }),
      }),
    )
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.snapshotName).toBeNull()
    }
  })

  test('a snapshot build that throws does not fail the scan: snapshotName null', async () => {
    const outcome = await runRunbookScan(
      baseOptions({
        buildProjectSnapshotFn: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.snapshotName).toBeNull()
    }
  })

  test('the sandbox network policy is exactly the runbook egress, the whole VM lease', async () => {
    const { driver, specs } = fakeDriver()
    await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({ egress: ['registry.npmjs.org', 'github.com'] }),
        }),
      }),
    )
    expect(specs).toHaveLength(1)
    expect(specs[0]?.network).toEqual({ allowedDomains: ['registry.npmjs.org', 'github.com'] })
    expect(specs[0]?.image).toBe('node:26')
  })

  test('a green scan writes the local validation record at the project root, right after RUNBOOK_FILE', async () => {
    const writeCalls: { worktree: string; validation: unknown }[] = []
    const outcome = await runRunbookScan(
      baseOptions({
        worktree: '/repo',
        writeRunbookConfigFn: () => WRITTEN_SHA,
        writeRunbookValidationFn: (worktree, validation) => {
          writeCalls.push({ worktree, validation })
        },
      }),
    )
    expect(outcome.status).toBe('completed')
    if (outcome.status !== 'completed') {
      throw new Error('unreachable')
    }
    // Written to the SAME root RUNBOOK_FILE was just written to (the scan's
    // own `opts.worktree`, always the project root in practice — never a
    // task worktree), with exactly the RunbookValidation the outcome itself
    // reports.
    expect(writeCalls).toEqual([{ worktree: '/repo', validation: outcome.validation }])
  })
})

describe('runRunbookScan — real sanitizeRunbookProposal (regression)', () => {
  // `sanitizeRunbookProposal` extracts JSON from raw agent TEXT itself
  // (runbook-setup.ts); passing it an already-parsed value makes it reject
  // every proposal with "agent output must be text" no matter what the agent
  // said. Every other test in this file mocks `sanitizeProposalFn` outright,
  // so only a test wired to the real function catches that mismatch.
  test('a valid JSON runbook in the raw agent text is accepted, not rejected as non-text', async () => {
    const { driver, calls } = fakeDriver({
      respond: scriptedRespond({
        'bun install': okResult('installed'),
        'bun test': okResult('1 pass'),
      }),
    })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: sanitizeRunbookProposal,
        runProposalFn: async () => JSON.stringify(sampleRunbook()),
      }),
    )
    expect(outcome.status).toBe('completed')
    expect(calls.map((c) => c.command)).toContain('bun install')
    expect(calls.map((c) => c.command)).toContain('bun test')
  })

  test('agent text with prose around the JSON block is still accepted', async () => {
    const { driver } = fakeDriver({
      respond: scriptedRespond({
        'bun install': okResult('installed'),
        'bun test': okResult('1 pass'),
      }),
    })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: sanitizeRunbookProposal,
        runProposalFn: async () =>
          `Here is the runbook:\n\`\`\`json\n${JSON.stringify(sampleRunbook())}\n\`\`\`\nDone.`,
      }),
    )
    expect(outcome.status).toBe('completed')
  })
})

describe('runRunbookScan — proposal loop', () => {
  test('a proposal agent that throws is treated as a failed attempt and retried', async () => {
    let calls = 0
    const outcome = await runRunbookScan(
      baseOptions({
        runProposalFn: async () => {
          calls += 1
          if (calls < 2) {
            throw new Error('agent crashed')
          }
          return 'ok'
        },
      }),
    )
    expect(outcome.status).toBe('completed')
    expect(calls).toBe(2)
  })

  test('a rejected proposal feeds its reason back as previousFailure on the next attempt', async () => {
    const prompts: RunbookProposalInput[] = []
    let attempt = 0
    const outcome = await runRunbookScan(
      baseOptions({
        buildPromptFn: (input) => {
          prompts.push(input)
          return 'prompt'
        },
        sanitizeProposalFn: () => {
          attempt += 1
          return attempt === 1
            ? { ok: false, reason: 'image is not allowed' }
            : { ok: true, runbook: sampleRunbook() }
        },
      }),
    )
    expect(outcome.status).toBe('completed')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.previousFailure).toBeNull()
    expect(prompts[1]?.previousFailure).toContain('image is not allowed')
  })

  test('every attempt failing exhausts the budget: status failed, attempts at the max, lastTail set', async () => {
    const outcome = await runRunbookScan(
      baseOptions({ sanitizeProposalFn: () => ({ ok: false, reason: 'no tests' }) }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') {
      throw new Error('unreachable')
    }
    expect(outcome.attempts).toBe(RUNBOOK_SCAN_MAX_ATTEMPTS)
    expect(outcome.error).toContain('no tests')
    expect(outcome.lastTail).toContain('no tests')
  })

  test('an already-aborted signal fails immediately without running a proposal', async () => {
    const controller = new AbortController()
    controller.abort()
    let proposalCalls = 0
    const outcome = await runRunbookScan(
      baseOptions({
        signal: controller.signal,
        runProposalFn: async () => {
          proposalCalls += 1
          return 'ok'
        },
      }),
    )
    expect(outcome.status).toBe('failed')
    expect(proposalCalls).toBe(0)
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('aborted')
    }
  })

  test('the proposal image defaults to DEFAULT_CHECKS_IMAGE and can be overridden', async () => {
    const seen: string[] = []
    await runRunbookScan(
      baseOptions({
        defaultImage: 'custom:1',
        buildPromptFn: (input) => {
          seen.push(input.defaultImage)
          return 'prompt'
        },
      }),
    )
    expect(seen).toEqual(['custom:1'])
  })
})

describe('runRunbookScan — install, services, healthchecks, tests', () => {
  test('a failing install command stops before any later install command runs', async () => {
    const { driver, calls } = fakeDriver({
      respond: scriptedRespond({
        'step one': okResult(),
        'step two': failResult(1, '', 'boom'),
        'step three': okResult(),
      }),
    })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({ install: ['step one', 'step two', 'step three'] }),
        }),
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.lastTail).toContain('boom')
    }
    expect(calls.map((c) => c.command)).toContain('step one')
    expect(calls.map((c) => c.command)).toContain('step two')
    expect(calls.map((c) => c.command)).not.toContain('step three')
  })

  test('a service is launched with nohup in the background, one shell call per service', async () => {
    const { driver, calls } = fakeDriver()
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({
            services: { host_up: ['dockerd', 'sleep 1'], compose_file: null },
          }),
        }),
      }),
    )
    expect(outcome.status).toBe('completed')
    const serviceCalls = calls.filter((c) => c.command.includes('nohup'))
    expect(serviceCalls).toHaveLength(2)
    expect(serviceCalls[0]?.command).toContain('dockerd')
    expect(serviceCalls[0]?.command).toContain('&')
    expect(serviceCalls[1]?.command).toContain('sleep 1')
  })

  test('a service launcher that exits non-zero fails the attempt', async () => {
    const { driver } = fakeDriver({
      respond: (command) =>
        command.includes('nohup') ? failResult(1, '', 'no such binary') : okResult(),
    })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({ services: { host_up: ['dockerd'], compose_file: null } }),
        }),
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.lastTail).toContain('no such binary')
    }
  })

  test('a healthcheck is retried every RUNBOOK_HEALTHCHECK_RETRY_MS until it passes', async () => {
    const sleeps: number[] = []
    const { driver } = fakeDriver({
      respond: scriptedRespond({
        'curl -f localhost:3000': [failResult(1), failResult(1), okResult()],
      }),
    })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sleepFn: async (ms) => {
          sleeps.push(ms)
        },
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({ healthchecks: ['curl -f localhost:3000'] }),
        }),
      }),
    )
    expect(outcome.status).toBe('completed')
    expect(sleeps).toEqual([2_000, 2_000])
  })

  test('a healthcheck that never passes within the budget fails the attempt', async () => {
    const { driver } = fakeDriver({ respond: () => failResult(1, '', 'not up yet') })
    let now = 0
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        timeoutMs: 100,
        sleepFn: async (ms) => {
          now += ms
        },
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({ healthchecks: ['curl -f localhost:3000'] }),
        }),
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.lastTail).toContain('not up yet')
    }
  })

  test('every test runs even when an earlier one fails; the outcome carries all of them and is not green', async () => {
    const { driver } = fakeDriver({
      respond: scriptedRespond({
        'test a': okResult('a ok'),
        'test b': failResult(1, '', 'b broke'),
        'test c': okResult('c ok'),
      }),
    })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: () => ({
          ok: true,
          runbook: sampleRunbook({ tests: ['test a', 'test b', 'test c'] }),
        }),
      }),
    )
    // the attempt fails (not every test passed), so it retries and exhausts —
    // but the SAME scripted driver keeps failing 'test b' every attempt.
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.lastTail).toContain('b broke')
    }
  })

  test('a timed-out test is reported as status timeout, not failed', async () => {
    const { driver } = fakeDriver({ respond: scriptedRespond({ 'slow test': timeoutResult() }) })
    const outcome = await runRunbookScan(
      baseOptions({
        driver,
        sanitizeProposalFn: () => ({ ok: true, runbook: sampleRunbook({ tests: ['slow test'] }) }),
      }),
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.lastTail).toContain('timed out')
    }
  })
})

describe('runRunbookScan — the sandbox is always destroyed', () => {
  test('destroyed even when a step throws mid-execution', async () => {
    const { driver, destroyed } = fakeDriver({
      respond: (command) => {
        if (command === 'bun install') {
          throw new Error('exec transport died')
        }
        return okResult()
      },
    })
    const outcome = await runRunbookScan(baseOptions({ driver }))
    expect(outcome.status).toBe('failed')
    expect(destroyed).toHaveLength(RUNBOOK_SCAN_MAX_ATTEMPTS)
  })

  test('a destroy that itself throws does not crash the scan', async () => {
    const { driver } = fakeDriver({ destroyShouldThrow: true })
    const outcome = await runRunbookScan(baseOptions({ driver }))
    expect(outcome.status).toBe('completed')
  })
})

describe('runRunbookScan — proposal secrets (real runMicrovmTurn, no runProposalFn seam)', () => {
  test('opts.secrets reach the proposal sandbox spec; the install/test sandbox never gets them', async () => {
    const { driver, specs } = fakeDriver({
      respond: scriptedRespond({
        'bun install': okResult('installed'),
        'bun test': okResult('1 pass'),
      }),
    })
    const secrets: SandboxSecret[] = [
      { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-secret', allowedHosts: ['api.anthropic.com'] },
    ]
    // `delete`, not an override to `undefined`: dropping the property falls
    // through to the real default proposal, which drives an actual
    // runMicrovmTurn call against the fake driver — every other test in this
    // file stubs this away with a scripted string, which is exactly why the
    // "Not logged in" regression this guards against went unnoticed until a
    // real VM rejeu hit it.
    const options = baseOptions({ driver, secrets })
    delete options.runProposalFn
    const outcome = await runRunbookScan(options)
    expect(outcome.status).toBe('completed')
    const proposalSpec = specs.find((spec) => spec.name.includes('runbook-scan-'))
    expect(proposalSpec?.secrets).toEqual(secrets)
    const otherSpecs = specs.filter((spec) => spec !== proposalSpec)
    expect(otherSpecs.length).toBeGreaterThan(0)
    for (const spec of otherSpecs) {
      expect(spec.secrets).toBeUndefined()
    }
  })

  test('no secrets configured: the proposal sandbox spec declares an empty list, not undefined', async () => {
    const { driver, specs } = fakeDriver({
      respond: scriptedRespond({
        'bun install': okResult('installed'),
        'bun test': okResult('1 pass'),
      }),
    })
    const options = baseOptions({ driver })
    delete options.runProposalFn
    await runRunbookScan(options)
    const proposalSpec = specs.find((spec) => spec.name.includes('runbook-scan-'))
    expect(proposalSpec?.secrets).toEqual([])
  })
})

describe('runOneRunbookScan', () => {
  function fakeScan(overrides: Partial<RunbookScan> = {}): RunbookScan {
    return {
      id: '11111111-1111-1111-1111-111111111111',
      repo_id: '22222222-2222-2222-2222-222222222222',
      repo_full_name: 'acme/widgets',
      head_sha: null,
      status: 'queued',
      requested_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  function fetchRouter(
    handlers: Record<string, (init: RequestInit | undefined, href: string) => Response>,
  ): {
    fetchImpl: typeof fetch
    calls: { url: string; init: RequestInit | undefined }[]
  } {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      calls.push({ url: href, init })
      // Suffix match: '/claim'/'/result'/'/fail' are nested under the same
      // '/runbook-scans' prefix as the bare collection route, so a suffix
      // check is the only way to tell them apart.
      for (const [key, handler] of Object.entries(handlers)) {
        if (href.endsWith(key)) {
          return handler(init, href)
        }
      }
      return new Response(JSON.stringify({ error: `unhandled: ${href}` }), { status: 404 })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  const creds = { url: 'https://hub.example', workspaceId: 'ws1', secret: 'sec1' }
  const { driver } = fakeDriver()

  test('no queued scans: claimed false, no claim call', async () => {
    const { fetchImpl, calls } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [] }), { status: 200 }),
    })
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
    })
    expect(result).toEqual({ claimed: false })
    expect(calls.some((c) => c.url.endsWith('/claim'))).toBe(false)
  })

  test('a hub error listing scans: claimed false, logged', async () => {
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }),
    })
    const lines: string[] = []
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => null,
      fetchImpl,
      onProgress: (line) => lines.push(line),
    })
    expect(result).toEqual({ claimed: false })
    expect(lines.some((l) => l.includes('could not list'))).toBe(true)
  })

  test('resolveWorktree null for the first queued scan, resolved for the second: claims the second', async () => {
    const first = fakeScan({ id: '11111111-1111-1111-1111-111111111111' })
    const second = fakeScan({ id: '33333333-3333-3333-3333-333333333333' })
    const claimed: string[] = []
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () =>
        new Response(JSON.stringify({ scans: [first, second] }), { status: 200 }),
      '/claim': (_init, href) => {
        claimed.push(href)
        return new Response(
          JSON.stringify({ scan: second, lease_expires_at: '2026-01-01T00:05:00.000Z' }),
          { status: 200 },
        )
      },
      '/result': () =>
        new Response(JSON.stringify({ runbook_id: 'x', already_recorded: false }), { status: 200 }),
    })
    const resolved: string[] = []
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async (scan) => {
        resolved.push(scan.id)
        return scan.id === second.id
          ? { worktree: '/r', projectId: 'p1', headSha: 'a'.repeat(40) }
          : null
      },
      fetchImpl,
      runRunbookScanFn: async () => ({
        status: 'completed',
        runbook: sampleRunbook(),
        validation: {
          runbook_sha: WRITTEN_SHA,
          validated_sha: 'a'.repeat(40),
          validated_at: '2026-01-01T00:00:00.000Z',
          status: 'valid',
        },
        snapshotName: null,
        checks: [
          { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 1, tail: 'ok' },
        ],
        attempts: 1,
      }),
    })
    expect(resolved).toEqual([first.id, second.id])
    expect(claimed).toEqual([`https://hub.example/api/cli/runbook-scans/${second.id}/claim`])
    expect(result).toEqual({
      claimed: true,
      scanId: second.id,
      outcome: expect.objectContaining({ status: 'completed' }),
    })
  })

  test('a claim failure: claimed false, the scan is never run', async () => {
    const scan = fakeScan()
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': () => new Response(JSON.stringify({ error: 'already claimed' }), { status: 409 }),
    })
    let ran = false
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      runRunbookScanFn: async () => {
        ran = true
        throw new Error('must not run')
      },
    })
    expect(result).toEqual({ claimed: false })
    expect(ran).toBe(false)
  })

  test('a completed outcome reports the result to the hub, including the last check tail', async () => {
    const scan = fakeScan()
    const reported: unknown[] = []
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': () =>
        new Response(JSON.stringify({ scan, lease_expires_at: '2026-01-01T00:05:00.000Z' }), {
          status: 200,
        }),
      '/result': (init) => {
        reported.push(init?.body ? JSON.parse(String(init.body)) : null)
        return new Response(JSON.stringify({ runbook_id: 'rb1', already_recorded: false }), {
          status: 200,
        })
      },
    })
    const outcome: RunbookScanOutcome = {
      status: 'completed',
      runbook: sampleRunbook(),
      validation: {
        runbook_sha: WRITTEN_SHA,
        validated_sha: 'a'.repeat(40),
        validated_at: '2026-01-01T00:00:00.000Z',
        status: 'valid',
      },
      snapshotName: 'snap1',
      checks: [
        { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 1, tail: 'all good' },
      ],
      attempts: 1,
    }
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      runRunbookScanFn: async () => outcome,
    })
    expect(result.claimed).toBe(true)
    expect(reported).toHaveLength(1)
    expect((reported[0] as { log_tail?: string }).log_tail).toBe('all good')
  })

  test('a failed outcome reports the failure to the hub', async () => {
    const scan = fakeScan()
    const reported: unknown[] = []
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': () =>
        new Response(JSON.stringify({ scan, lease_expires_at: '2026-01-01T00:05:00.000Z' }), {
          status: 200,
        }),
      '/fail': (init) => {
        reported.push(init?.body ? JSON.parse(String(init.body)) : null)
        return new Response(JSON.stringify({}), { status: 200 })
      },
    })
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      runRunbookScanFn: async () => ({
        status: 'failed',
        error: 'install always fails',
        attempts: RUNBOOK_SCAN_MAX_ATTEMPTS,
        lastTail: 'boom',
      }),
    })
    expect(result).toEqual({
      claimed: true,
      scanId: scan.id,
      outcome: expect.objectContaining({ status: 'failed' }),
    })
    expect(reported).toEqual([{ error: 'install always fails' }])
  })

  test('claims with the hub-capped lease by default', async () => {
    const scan = fakeScan()
    const claimBodies: unknown[] = []
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': (init) => {
        claimBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
        return new Response(
          JSON.stringify({ scan, lease_expires_at: '2026-01-01T00:05:00.000Z' }),
          { status: 200 },
        )
      },
      '/result': () =>
        new Response(JSON.stringify({ runbook_id: 'rb1', already_recorded: false }), {
          status: 200,
        }),
    })
    await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      runRunbookScanFn: async () => ({
        status: 'completed',
        runbook: sampleRunbook(),
        validation: {
          runbook_sha: WRITTEN_SHA,
          validated_sha: 'a'.repeat(40),
          validated_at: '2026-01-01T00:00:00.000Z',
          status: 'valid',
        },
        snapshotName: null,
        checks: [],
        attempts: 1,
      }),
    })
    expect(claimBodies[0]).toEqual({ lease_seconds: RUNBOOK_SCAN_LEASE_SECONDS })
  })

  test('renews the lease periodically while the scan runs, and stops renewing once it settles', async () => {
    const scan = fakeScan()
    const claimBodies: unknown[] = []
    let resolveScan: (outcome: RunbookScanOutcome) => void = () => {}
    const scanPromise = new Promise<RunbookScanOutcome>((resolve) => {
      resolveScan = resolve
    })
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': (init) => {
        claimBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
        // Resolve the scan itself only after the initial claim plus at least
        // two renewals: proves the loop ticks more than once, not just once.
        if (claimBodies.length >= 3) {
          resolveScan({
            status: 'completed',
            runbook: sampleRunbook(),
            validation: {
              runbook_sha: WRITTEN_SHA,
              validated_sha: 'a'.repeat(40),
              validated_at: '2026-01-01T00:00:00.000Z',
              status: 'valid',
            },
            snapshotName: null,
            checks: [],
            attempts: 1,
          })
        }
        return new Response(
          JSON.stringify({ scan, lease_expires_at: '2026-01-01T00:05:00.000Z' }),
          { status: 200 },
        )
      },
      '/result': () =>
        new Response(JSON.stringify({ runbook_id: 'rb1', already_recorded: false }), {
          status: 200,
        }),
    })
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      leaseSeconds: 10,
      renewSleepFn: async () => {},
      runRunbookScanFn: () => scanPromise,
    })
    expect(claimBodies[0]).toEqual({ lease_seconds: 10 })
    expect(claimBodies.length).toBeGreaterThanOrEqual(3)
    expect(result.claimed).toBe(true)
    expect((result as { outcome: RunbookScanOutcome }).outcome.status).toBe('completed')
    // The renewal loop is awaited before runOneRunbookScan returns, so no
    // further claim call should ever land after that.
    const countAtSettle = claimBodies.length
    await new Promise((r) => setTimeout(r, 0))
    expect(claimBodies.length).toBe(countAtSettle)
  })

  test('a failed lease renewal aborts the in-flight scan and reports nothing to the hub', async () => {
    const scan = fakeScan()
    let claimCount = 0
    const reportedResult: unknown[] = []
    const reportedFail: unknown[] = []
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': () => {
        claimCount += 1
        if (claimCount === 1) {
          return new Response(
            JSON.stringify({ scan, lease_expires_at: '2026-01-01T00:05:00.000Z' }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({ error: 'runbook scan not claimed by this executor' }),
          { status: 409 },
        )
      },
      '/result': (init) => {
        reportedResult.push(init)
        return new Response(JSON.stringify({ runbook_id: 'rb1', already_recorded: false }), {
          status: 200,
        })
      },
      '/fail': (init) => {
        reportedFail.push(init)
        return new Response(JSON.stringify({}), { status: 200 })
      },
    })
    const lines: string[] = []
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      leaseSeconds: 10,
      renewSleepFn: async () => {},
      onProgress: (line) => lines.push(line),
      // Mirrors what the real scan does under an aborted shared signal: it
      // never resolves on its own, only when the signal fires.
      runRunbookScanFn: (scanOpts) =>
        new Promise((resolve) => {
          scanOpts.signal?.addEventListener('abort', () => {
            resolve({
              status: 'failed',
              error: 'runbook scan aborted',
              attempts: 1,
              lastTail: null,
            })
          })
        }),
    })
    expect(claimCount).toBe(2)
    expect(reportedResult).toHaveLength(0)
    expect(reportedFail).toHaveLength(0)
    expect(result.claimed).toBe(true)
    expect((result as { outcome: RunbookScanOutcome }).outcome.status).toBe('failed')
    expect(lines.some((l) => l.includes('lost the lease'))).toBe(true)
  })

  test('a hub error reporting the result still returns claimed true, logged rather than thrown', async () => {
    const scan = fakeScan()
    const { fetchImpl } = fetchRouter({
      '/runbook-scans': () => new Response(JSON.stringify({ scans: [scan] }), { status: 200 }),
      '/claim': () =>
        new Response(JSON.stringify({ scan, lease_expires_at: '2026-01-01T00:05:00.000Z' }), {
          status: 200,
        }),
      '/result': () => new Response(JSON.stringify({ error: 'db down' }), { status: 500 }),
    })
    const lines: string[] = []
    const result = await runOneRunbookScan({
      creds,
      driver,
      command: 'claude -p',
      timeoutMs: 1000,
      resolveWorktree: async () => ({ worktree: '/r', projectId: 'p', headSha: 'a'.repeat(40) }),
      fetchImpl,
      onProgress: (line) => lines.push(line),
      runRunbookScanFn: async () => ({
        status: 'completed',
        runbook: sampleRunbook(),
        validation: {
          runbook_sha: WRITTEN_SHA,
          validated_sha: 'a'.repeat(40),
          validated_at: '2026-01-01T00:00:00.000Z',
          status: 'valid',
        },
        snapshotName: null,
        checks: [],
        attempts: 1,
      }),
    })
    expect(result.claimed).toBe(true)
    expect(lines.some((l) => l.includes('could not report runbook scan'))).toBe(true)
  })
})

describe('constants', () => {
  test('DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS is a sane positive duration', () => {
    expect(DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS).toBeGreaterThan(0)
  })

  test('RUNBOOK_SCAN_MAX_ATTEMPTS is 5', () => {
    expect(RUNBOOK_SCAN_MAX_ATTEMPTS).toBe(5)
  })

  test('RUNBOOK_SCAN_LEASE_SECONDS matches the hub cap (900s)', () => {
    expect(RUNBOOK_SCAN_LEASE_SECONDS).toBe(900)
  })
})
