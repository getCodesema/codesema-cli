import { describe, expect, test } from 'bun:test'
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMetrics,
} from './microsandbox-driver.js'
import { captureProof, type CaptureProofOptions } from './task-proof.js'

type Call = { method: string; args: unknown[] }

const ok = (over: Partial<SandboxExecResult> = {}): SandboxExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
})

function fakeHandle(opts: {
  script?: (command: string, execOpts: SandboxExecOptions) => SandboxExecResult
  copyToHostFails?: boolean
}): { handle: SandboxHandle; calls: Call[] } {
  const calls: Call[] = []
  const script = opts.script ?? (() => ok())
  const handle: SandboxHandle = {
    name: 'fake',
    exec: (command, args, execOpts) => {
      calls.push({ method: 'exec', args: [command, args] })
      return Promise.resolve(script(command, execOpts))
    },
    shell: (command, execOpts) => {
      calls.push({ method: 'shell', args: [command] })
      return Promise.resolve(script(command, execOpts))
    },
    copyFromHost: () => Promise.resolve(),
    copyToHost: (guestPath, hostPath) => {
      calls.push({ method: 'copyToHost', args: [guestPath, hostPath] })
      if (opts.copyToHostFails) {
        return Promise.reject(new Error('copy failed'))
      }
      return Promise.resolve()
    },
    writeFile: () => Promise.resolve(),
    readFile: () => Promise.resolve(''),
    metrics: (): Promise<SandboxMetrics> =>
      Promise.resolve({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
    stop: () => Promise.resolve(),
  }
  return { handle, calls }
}

function baseOpts(overrides: Partial<CaptureProofOptions> = {}): CaptureProofOptions {
  return {
    journey: 'journeys/login.spec.ts',
    url: 'http://localhost:3000',
    timeoutMs: 5000,
    guestWorkDir: '/work',
    guestProofDir: '/work/.proof',
    hostIncomingDir: '/host/incoming',
    ...overrides,
  }
}

describe('captureProof', () => {
  test('a passing replay copies the proof dir, in mkdir -> replay -> copyToHost order', async () => {
    const { handle, calls } = fakeHandle({})
    const result = await captureProof(handle, baseOpts())
    expect(result).toEqual({ status: 'passed', reason: null })
    expect(calls.map((c) => c.method)).toEqual(['shell', 'shell', 'copyToHost'])
    expect(calls[0]?.args[0]).toBe('mkdir -p /work/.proof')
    const replay = calls[1]?.args[0] as string
    expect(replay).toContain("CODESEMA_BASE_URL='http://localhost:3000'")
    expect(replay).toContain('CODESEMA_PROOF_DIR=/work/.proof')
    expect(replay).toContain("npx playwright test 'journeys/login.spec.ts'")
    expect(replay).toContain('--output=/work/.proof')
    expect(calls[2]).toEqual({
      method: 'copyToHost',
      args: ['/work/.proof', '/host/incoming'],
    })
  })

  test('a failing replay attempts a fallback screenshot and reports the tail as reason', async () => {
    const { handle, calls } = fakeHandle({
      script: (command) =>
        command.includes('npx playwright test')
          ? ok({ code: 1, stderr: 'assertion failed' })
          : ok(),
    })
    const result = await captureProof(handle, baseOpts())
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('assertion failed')
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0] as string)
    expect(shellCommands[2]).toContain('npx playwright screenshot --full-page')
    expect(shellCommands[2]).toContain("'http://localhost:3000'")
    expect(shellCommands[2]).toContain('/work/.proof/fallback.png')
    expect(calls.some((c) => c.method === 'copyToHost')).toBe(true)
  })

  test('a timed out replay reports an explicit timeout reason and still attempts the fallback', async () => {
    const { handle, calls } = fakeHandle({
      script: (command) =>
        command.includes('npx playwright test') ? ok({ timedOut: true, code: null }) : ok(),
    })
    const result = await captureProof(handle, baseOpts({ timeoutMs: 1234 }))
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('timed out')
    expect(result.reason).toContain('1234')
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0] as string)
    expect(shellCommands[2]).toContain('npx playwright screenshot')
  })

  test('an apostrophe in the url is refused without ever running the replay shell', async () => {
    const { handle, calls } = fakeHandle({})
    const result = await captureProof(handle, baseOpts({ url: "http://localhost:3000/it's" }))
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('url')
    expect(result.reason).toContain('single quote')
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0] as string)
    expect(shellCommands).toEqual(['mkdir -p /work/.proof'])
    expect(calls.some((c) => c.method === 'copyToHost')).toBe(true)
  })

  test('an apostrophe in the journey is refused the same way', async () => {
    const { handle, calls } = fakeHandle({})
    const result = await captureProof(handle, baseOpts({ journey: "journeys/it's-broken.spec.ts" }))
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('journey')
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0] as string)
    expect(shellCommands).toEqual(['mkdir -p /work/.proof'])
  })

  test('a copy failure after a passing replay degrades the verdict to failed', async () => {
    const { handle } = fakeHandle({ copyToHostFails: true })
    const result = await captureProof(handle, baseOpts())
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('copy')
  })

  test('a copy failure after an already-failing replay keeps the original failure reason', async () => {
    const { handle } = fakeHandle({
      script: (command) =>
        command.includes('npx playwright test') ? ok({ code: 1, stderr: 'boom' }) : ok(),
      copyToHostFails: true,
    })
    const result = await captureProof(handle, baseOpts())
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('boom')
  })

  test('the reason tail is bounded to 2000 characters', async () => {
    const { handle } = fakeHandle({
      script: (command) =>
        command.includes('npx playwright test') ? ok({ code: 1, stderr: 'x'.repeat(3000) }) : ok(),
    })
    const result = await captureProof(handle, baseOpts())
    expect(result.reason).toHaveLength(2000)
  })

  test('no exception ever escapes captureProof, even when the sandbox rejects', async () => {
    const handle: SandboxHandle = {
      name: 'broken',
      exec: () => Promise.reject(new Error('exec unavailable')),
      shell: () => Promise.reject(new Error('sandbox is gone')),
      copyFromHost: () => Promise.resolve(),
      copyToHost: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      readFile: () => Promise.resolve(''),
      metrics: (): Promise<SandboxMetrics> =>
        Promise.resolve({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
      stop: () => Promise.resolve(),
    }
    const result = await captureProof(handle, baseOpts())
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('sandbox is gone')
  })
})
