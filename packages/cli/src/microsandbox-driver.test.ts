import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createMicrosandboxDriver,
  FakeSandboxDriver,
  SANDBOX_NAME_PREFIX,
  sandboxName,
  sweepOrphanedSandboxes,
  type SandboxDriver,
  type SandboxExecOptions,
  type SandboxHandle,
  type SandboxNetworkPolicy,
  type SandboxSpec,
} from './microsandbox-driver.js'

// --- shared fixtures ---------------------------------------------------------

const NETWORK: SandboxNetworkPolicy = { allowedDomains: ['api.anthropic.com'] }

function baseSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: sandboxName('dev', 't1'),
    image: 'node:26',
    cpus: 2,
    memoryMib: 2048,
    maxDurationSeconds: 3600,
    network: NETWORK,
    ...over,
  }
}

function snapshotSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: sandboxName('dev', 't1'),
    fromSnapshot: 'snap-1',
    cpus: 2,
    memoryMib: 2048,
    maxDurationSeconds: 3600,
    network: NETWORK,
    ...over,
  }
}

const EXEC_OPTS: SandboxExecOptions = { timeoutMs: 5_000 }

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(prefix = 'codesema-microsandbox-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

// --- sandboxName / prefix ----------------------------------------------------

describe('sandboxName', () => {
  test('joins the prefix, role and id', () => {
    expect(sandboxName('dev', 'abc123')).toBe('codesema-dev-abc123')
    expect(sandboxName('gitops', 't-9')).toBe(`${SANDBOX_NAME_PREFIX}gitops-t-9`)
  })
})

// --- FakeSandboxDriver: create -----------------------------------------------

describe('FakeSandboxDriver.create', () => {
  test('refuses a spec with no network policy', async () => {
    const driver = new FakeSandboxDriver()
    // A decayed (non-typed) caller could reach this; the field is required by
    // the type but the runtime guard is what actually protects the boundary.
    const spec = { ...baseSpec(), network: undefined } as unknown as SandboxSpec
    await expect(driver.create(spec)).rejects.toThrow(/network is required/)
  })

  test('refuses image and fromSnapshot together', async () => {
    const driver = new FakeSandboxDriver()
    await expect(
      driver.create(baseSpec({ image: 'node:26', fromSnapshot: 'snap-1' })),
    ).rejects.toThrow(/exactly one of image or fromSnapshot/)
  })

  test('refuses neither image nor fromSnapshot', async () => {
    const driver = new FakeSandboxDriver()
    const spec = { ...baseSpec(), image: undefined } as unknown as SandboxSpec
    await expect(driver.create(spec)).rejects.toThrow(/exactly one of image or fromSnapshot/)
  })

  test('accepts fromSnapshot alone', async () => {
    const driver = new FakeSandboxDriver()
    const handle = await driver.create(snapshotSpec())
    expect(handle.name).toBe(sandboxName('dev', 't1'))
  })

  test('records the call', async () => {
    const driver = new FakeSandboxDriver()
    const spec = baseSpec()
    await driver.create(spec)
    expect(driver.calls).toContainEqual({ method: 'create', args: [spec] })
    expect(driver.sandboxes.get(spec.name)?.spec).toBe(spec)
    expect(driver.sandboxes.get(spec.name)?.stopped).toBe(false)
    expect(driver.sandboxes.get(spec.name)?.destroyed).toBe(false)
  })
})

// --- FakeSandboxDriver: exec / shell scripting -------------------------------

describe('FakeSandboxDriver exec/shell', () => {
  test('default response is exit 0 with empty output', async () => {
    const driver = new FakeSandboxDriver()
    const handle = await driver.create(baseSpec())
    const result = await handle.exec('echo', ['hi'], EXEC_OPTS)
    expect(result).toEqual({ code: 0, stdout: '', stderr: '', timedOut: false })
  })

  test('constructor exec responder answers every unscripted call', async () => {
    const driver = new FakeSandboxDriver({
      exec: ({ command }) => ({ code: 0, stdout: `ran ${command}` }),
    })
    const handle = await driver.create(baseSpec())
    const result = await handle.exec('claude', ['-p'], EXEC_OPTS)
    expect(result.stdout).toBe('ran claude')
    expect(result.code).toBe(0)
  })

  test('script() takes priority over the constructor default, first match wins', async () => {
    const driver = new FakeSandboxDriver({ exec: () => ({ stdout: 'default' }) })
    driver
      .script(
        (ctx) => ctx.command === 'claude',
        () => ({ stdout: 'first' }),
      )
      .script(
        (ctx) => ctx.command === 'claude',
        () => ({ stdout: 'second' }),
      )
    const handle = await driver.create(baseSpec())
    const claude = await handle.exec('claude', [], EXEC_OPTS)
    expect(claude.stdout).toBe('first')
    const other = await handle.exec('git', ['status'], EXEC_OPTS)
    expect(other.stdout).toBe('default')
  })

  test('onText receives stdout then stderr, in that order', async () => {
    const driver = new FakeSandboxDriver({ exec: () => ({ stdout: 'out', stderr: 'err' }) })
    const handle = await driver.create(baseSpec())
    const chunks: string[] = []
    await handle.exec('cmd', [], { ...EXEC_OPTS, onText: (c) => chunks.push(c) })
    expect(chunks).toEqual(['out', 'err'])
  })

  test('shell() is recorded as `sh -lc <script>` and reuses the exec scripting', async () => {
    const driver = new FakeSandboxDriver()
    driver.script((ctx) => ctx.command === 'sh' && ctx.args[1] === 'claude -p hi', {
      stdout: 'matched',
    })
    const handle = await driver.create(baseSpec())
    const result = await handle.shell('claude -p hi', EXEC_OPTS)
    expect(result.stdout).toBe('matched')
    const state = driver.sandboxes.get(baseSpec().name)
    expect(state?.execs).toEqual([
      { command: 'sh', args: ['-lc', 'claude -p hi'], opts: EXEC_OPTS },
    ])
  })

  test('exit code and timedOut are honored from the script', async () => {
    const driver = new FakeSandboxDriver()
    driver.script(() => true, { code: 1, timedOut: true, stderr: 'boom' })
    const handle = await driver.create(baseSpec())
    const result = await handle.exec('x', [], EXEC_OPTS)
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'boom', timedOut: true })
  })
})

// --- FakeSandboxDriver: fs, metrics, stop ------------------------------------

describe('FakeSandboxDriver fs/metrics/stop', () => {
  test('writeFile then readFile round-trips in memory', async () => {
    const driver = new FakeSandboxDriver()
    const handle = await driver.create(baseSpec())
    await handle.writeFile('/work/out.txt', 'hello')
    expect(await handle.readFile('/work/out.txt')).toBe('hello')
  })

  test('readFile on a missing path throws', async () => {
    const driver = new FakeSandboxDriver()
    const handle = await driver.create(baseSpec())
    await expect(handle.readFile('/nope')).rejects.toThrow(/file not found/)
  })

  test('copyFromHost/copyToHost are recorded, not executed', async () => {
    const driver = new FakeSandboxDriver()
    const handle = await driver.create(baseSpec())
    await handle.copyFromHost('/host/a', '/guest/a')
    await handle.copyToHost('/guest/b', '/host/b')
    expect(driver.calls).toContainEqual({
      method: 'copyFromHost',
      args: [baseSpec().name, '/host/a', '/guest/a'],
    })
    expect(driver.calls).toContainEqual({
      method: 'copyToHost',
      args: [baseSpec().name, '/guest/b', '/host/b'],
    })
  })

  test('metrics defaults to nulls', async () => {
    const driver = new FakeSandboxDriver()
    const handle = await driver.create(baseSpec())
    expect(await handle.metrics()).toEqual({
      memoryHostResidentBytes: null,
      memoryBytes: null,
      cpuPercent: null,
    })
  })

  test('stop marks the sandbox stopped', async () => {
    const driver = new FakeSandboxDriver()
    const spec = baseSpec()
    const handle = await driver.create(spec)
    expect(driver.sandboxes.get(spec.name)?.stopped).toBe(false)
    await handle.stop()
    expect(driver.sandboxes.get(spec.name)?.stopped).toBe(true)
  })
})

// --- FakeSandboxDriver: snapshot ----------------------------------------------

describe('FakeSandboxDriver.snapshot', () => {
  test('refuses a running sandbox', async () => {
    const driver = new FakeSandboxDriver()
    const spec = baseSpec()
    await driver.create(spec)
    await expect(driver.snapshot(spec.name, 'snap-1')).rejects.toThrow(/still running/)
  })

  test('refuses an unknown sandbox', async () => {
    const driver = new FakeSandboxDriver()
    await expect(driver.snapshot('does-not-exist', 'snap-1')).rejects.toThrow(/not found/)
  })

  test('refuses a flat root disk, matching the real SDK message', async () => {
    const driver = new FakeSandboxDriver()
    const spec = baseSpec({ rootDisk: { kind: 'flat', sizeMib: 10_240 } })
    const handle = await driver.create(spec)
    await handle.stop()
    await expect(driver.snapshot(spec.name, 'snap-1')).rejects.toThrow(
      /flat root disk, which is not yet supported by snapshots/,
    )
  })

  test('succeeds on a stopped managed-disk sandbox and is listed after', async () => {
    const driver = new FakeSandboxDriver()
    const spec = baseSpec({ rootDisk: { kind: 'managed', sizeMib: 4096 } })
    const handle = await driver.create(spec)
    await handle.stop()
    const info = await driver.snapshot(spec.name, 'snap-1')
    expect(info).toEqual({ name: 'snap-1', sizeBytes: null })
    expect(await driver.listSnapshots()).toEqual([{ name: 'snap-1', sizeBytes: null }])
  })
})

// --- FakeSandboxDriver: listSandboxes / destroy / removeSnapshot / volumes ---

describe('FakeSandboxDriver lifecycle', () => {
  test('listSandboxes excludes destroyed sandboxes', async () => {
    const driver = new FakeSandboxDriver()
    const a = baseSpec({ name: sandboxName('dev', 'a') })
    const b = baseSpec({ name: sandboxName('dev', 'b') })
    await driver.create(a)
    await driver.create(b)
    await driver.destroy(a.name)
    expect(await driver.listSandboxes()).toEqual([b.name])
  })

  test('destroy on an unknown sandbox is a no-op', async () => {
    const driver = new FakeSandboxDriver()
    await expect(driver.destroy('nope')).resolves.toBeUndefined()
  })

  test('removeSnapshot drops it from listSnapshots', async () => {
    const driver = new FakeSandboxDriver()
    const spec = baseSpec()
    const handle = await driver.create(spec)
    await handle.stop()
    await driver.snapshot(spec.name, 'snap-1')
    await driver.removeSnapshot('snap-1')
    expect(await driver.listSnapshots()).toEqual([])
  })

  test('ensureVolume is idempotent', async () => {
    const driver = new FakeSandboxDriver()
    await driver.ensureVolume('vol-1', { kind: 'disk', sizeMib: 1024 })
    await driver.ensureVolume('vol-1', { kind: 'directory' })
    expect(driver.volumes.get('vol-1')).toEqual({ kind: 'disk', sizeMib: 1024 })
    expect(driver.calls.filter((c) => c.method === 'ensureVolume')).toHaveLength(2)
  })

  test('removeVolume drops it', async () => {
    const driver = new FakeSandboxDriver()
    await driver.ensureVolume('vol-1', { kind: 'disk' })
    await driver.removeVolume('vol-1')
    expect(driver.volumes.has('vol-1')).toBe(false)
  })
})

// --- sweepOrphanedSandboxes ---------------------------------------------------

describe('sweepOrphanedSandboxes', () => {
  async function seeded(names: string[]): Promise<FakeSandboxDriver> {
    const driver = new FakeSandboxDriver()
    for (const name of names) {
      await driver.create(baseSpec({ name }))
    }
    return driver
  }

  test('ignores names outside the codesema- prefix or without a known role', async () => {
    const driver = await seeded([
      'other-thing',
      'codesema-unknownrole-x',
      sandboxName('dev', 'claimed'),
    ])
    const outcome = await sweepOrphanedSandboxes({ driver, claimedIds: new Set(['claimed']) })
    expect(outcome.removed).toEqual([])
    expect(outcome.notices).toEqual([])
  })

  test('removes an orphaned sandbox and reports it', async () => {
    const driver = await seeded([sandboxName('dev', 'orphan'), sandboxName('checks', 'kept')])
    const outcome = await sweepOrphanedSandboxes({ driver, claimedIds: new Set(['kept']) })
    expect(outcome.removed).toEqual(['orphan'])
    expect(outcome.notices).toEqual([
      `orphaned sandbox ${sandboxName('dev', 'orphan')} removed at boot: no task record claims it`,
    ])
    expect(await driver.listSandboxes()).toEqual([sandboxName('checks', 'kept')])
  })

  test('never touches a claimed sandbox', async () => {
    const driver = await seeded([sandboxName('dev', 'kept')])
    const outcome = await sweepOrphanedSandboxes({ driver, claimedIds: new Set(['kept']) })
    expect(outcome.removed).toEqual([])
    expect(await driver.listSandboxes()).toEqual([sandboxName('dev', 'kept')])
  })

  test('recheckClaimedIds returning null leaves the candidate in place with a notice', async () => {
    const driver = await seeded([sandboxName('dev', 'maybe')])
    const outcome = await sweepOrphanedSandboxes({
      driver,
      claimedIds: new Set(),
      recheckClaimedIds: () => null,
    })
    expect(outcome.removed).toEqual([])
    expect(outcome.notices[0]).toMatch(/could not be re-verified/)
    expect(await driver.listSandboxes()).toEqual([sandboxName('dev', 'maybe')])
  })

  test('recheckClaimedIds closes the race: a freshly claimed id survives', async () => {
    const driver = await seeded([sandboxName('dev', 'race')])
    const outcome = await sweepOrphanedSandboxes({
      driver,
      claimedIds: new Set(),
      recheckClaimedIds: () => new Set(['race']),
    })
    expect(outcome.removed).toEqual([])
    expect(await driver.listSandboxes()).toEqual([sandboxName('dev', 'race')])
  })

  test('never throws: a listSandboxes failure becomes a notice', async () => {
    const driver: SandboxDriver = {
      kind: 'fake',
      probe: () => Promise.reject(new Error('unused')),
      create: () => Promise.reject(new Error('unused')),
      snapshot: () => Promise.reject(new Error('unused')),
      listSandboxes: () => Promise.reject(new Error('daemon unreachable')),
      listSnapshots: () => Promise.resolve([]),
      destroy: () => Promise.resolve(),
      removeSnapshot: () => Promise.resolve(),
      ensureVolume: () => Promise.resolve(),
      removeVolume: () => Promise.resolve(),
    }
    const outcome = await sweepOrphanedSandboxes({ driver, claimedIds: new Set() })
    expect(outcome.removed).toEqual([])
    expect(outcome.notices).toEqual(['could not list sandboxes: daemon unreachable'])
  })

  test('never throws: a destroy failure becomes a notice and the sweep continues', async () => {
    const driver = await seeded([sandboxName('dev', 'stuck'), sandboxName('dev', 'fine')])
    const real = driver.destroy.bind(driver)
    driver.destroy = (name: string) =>
      name.includes('stuck') ? Promise.reject(new Error('busy')) : real(name)
    const outcome = await sweepOrphanedSandboxes({ driver, claimedIds: new Set() })
    expect(outcome.removed).toEqual(['fine'])
    expect(outcome.notices).toContain(
      `orphaned sandbox ${sandboxName('dev', 'stuck')} could not be removed: busy`,
    )
  })
})

// --- createMicrosandboxDriver: fake SDK plumbing -----------------------------
//
// The real `microsandbox` SDK is optional and never imported at module load.
// These tests inject a minimal fake module (via MicrosandboxDriverOptions.sdk)
// that mimics the fluent builder shapes documented in
// node_modules/microsandbox/dist/internal/napi.d.ts, so the driver's own
// wiring is exercised without a real microVM.

type RecordedRule = { domain: string; port: number | null }
type RecordedPolicy = { defaultEgress: string; defaultIngress: string; rules: RecordedRule[] }
type RecordedSecret = { env: string; value: string; allowedHosts: string[] }
type RecordedVolume = { guest: string; name: string; readonly: boolean }
type RecordedRootDisk = { kind: 'managed' | 'flat'; sizeMib: number }

type RecordedSandboxConfig = {
  name: string
  image?: string
  fromSnapshot?: string
  cpus?: number
  memoryMib?: number
  rootDisk?: RecordedRootDisk
  maxDurationSeconds?: number
  replaced: boolean
  network?: RecordedPolicy
  secrets: RecordedSecret[]
  env: Record<string, string>
  workdir?: string
  user?: string
  volumes: RecordedVolume[]
}

type FakeExecEvent =
  | { kind: 'started'; pid: number }
  | { kind: 'stdout'; data: Uint8Array }
  | { kind: 'stderr'; data: Uint8Array }
  | { kind: 'exited'; code: number }

type FakeExecOptionsBuilder = {
  args(a: string[]): FakeExecOptionsBuilder
  cwd(c: string): FakeExecOptionsBuilder
  user(u: string): FakeExecOptionsBuilder
  env(k: string, v: string): FakeExecOptionsBuilder
  timeout(ms: number): FakeExecOptionsBuilder
  stdinBytes(d: Uint8Array): FakeExecOptionsBuilder
  stdinNull(): FakeExecOptionsBuilder
}

type RecordedExecOptions = {
  args: string[]
  cwd?: string
  user?: string
  env: Record<string, string>
  timeoutMs?: number
  stdin: 'null' | 'bytes' | 'unset'
  stdinText?: string
}

function makeExecOptionsBuilder(): {
  builder: FakeExecOptionsBuilder
  recorded: RecordedExecOptions
} {
  const recorded: RecordedExecOptions = { args: [], env: {}, stdin: 'unset' }
  const decoder = new TextDecoder()
  const builder: FakeExecOptionsBuilder = {
    args: (a) => {
      recorded.args = a
      return builder
    },
    cwd: (c) => {
      recorded.cwd = c
      return builder
    },
    user: (u) => {
      recorded.user = u
      return builder
    },
    env: (k, v) => {
      recorded.env[k] = v
      return builder
    },
    timeout: (ms) => {
      recorded.timeoutMs = ms
      return builder
    },
    stdinBytes: (d) => {
      recorded.stdin = 'bytes'
      recorded.stdinText = decoder.decode(d)
      return builder
    },
    stdinNull: () => {
      recorded.stdin = 'null'
      return builder
    },
  }
  return { builder, recorded }
}

function makeExecHandle(
  events: FakeExecEvent[],
  opts: { throwOnIterate?: unknown; onKill?: () => void } = {},
): { [Symbol.asyncIterator](): AsyncIterator<FakeExecEvent>; kill: () => Promise<void> } {
  let killed = false
  async function* iterate(): AsyncGenerator<FakeExecEvent> {
    for (const ev of events) {
      if (killed) {
        return
      }
      yield ev
    }
    if (opts.throwOnIterate !== undefined) {
      throw opts.throwOnIterate
    }
  }
  return {
    [Symbol.asyncIterator]: iterate,
    kill: async () => {
      killed = true
      opts.onKill?.()
    },
  }
}

function textEvent(kind: 'stdout' | 'stderr', text: string): FakeExecEvent {
  return { kind, data: new TextEncoder().encode(text) }
}

type FakeSdkHooks = {
  onCreate?: (config: RecordedSandboxConfig) => unknown
  onExec?: (
    config: RecordedSandboxConfig,
    command: string,
    execOpts: RecordedExecOptions,
  ) => ReturnType<typeof makeExecHandle>
  onGet?: (name: string) => unknown
  onSandboxRemove?: (name: string) => void
  onListWith?: () => { sandboxes: { name: string }[] }
  onVolumeCreate?: (name: string, kind: 'disk' | 'directory', sizeMib: number | undefined) => void
  onVolumeRemove?: (name: string) => void
  onSnapshotList?: () => { name: string | null; sizeBytes: bigint | null }[]
  onSnapshotRemove?: (name: string, opts: { force?: boolean } | undefined) => void
}

/** Minimal fake of the `microsandbox` module, structurally matching the driver's internal seam. */
function makeFakeSdk(hooks: FakeSdkHooks = {}) {
  const builderCalls: string[] = []

  function policyBuilder() {
    const policy: RecordedPolicy = { defaultEgress: '', defaultIngress: '', rules: [] }
    const b = {
      defaultEgress: (a: string) => {
        policy.defaultEgress = a
        return b
      },
      defaultIngress: (a: string) => {
        policy.defaultIngress = a
        return b
      },
      egress: (
        configure: (rb: {
          allowDomain: (d: string) => unknown
          port: (p: number) => unknown
        }) => unknown,
      ) => {
        const rule: RecordedRule = { domain: '', port: null }
        const rb = {
          allowDomain: (d: string) => {
            rule.domain = d
            return rb
          },
          port: (p: number) => {
            rule.port = p
            return rb
          },
        }
        configure(rb)
        policy.rules.push(rule)
        return b
      },
      build: () => policy,
    }
    return b
  }

  function sandboxBuilder(name: string) {
    const config: RecordedSandboxConfig = {
      name,
      replaced: false,
      secrets: [],
      env: {},
      volumes: [],
    }
    const b = {
      image: (ref: string) => {
        config.image = ref
        builderCalls.push('image')
        return b
      },
      fromSnapshot: (ref: string) => {
        config.fromSnapshot = ref
        builderCalls.push('fromSnapshot')
        return b
      },
      cpus: (n: number) => {
        config.cpus = n
        builderCalls.push('cpus')
        return b
      },
      memory: (mib: number) => {
        config.memoryMib = mib
        builderCalls.push('memory')
        return b
      },
      rootDisk: (
        arg: number | ((d: { flat: () => unknown; size: (mib: number) => unknown }) => unknown),
      ) => {
        builderCalls.push('rootDisk')
        if (typeof arg === 'number') {
          config.rootDisk = { kind: 'managed', sizeMib: arg }
        } else {
          const rd = { kind: 'flat' as const, sizeMib: 0 }
          const rdBuilder = {
            flat: () => rdBuilder,
            size: (mib: number) => {
              rd.sizeMib = mib
              return rdBuilder
            },
          }
          arg(rdBuilder)
          config.rootDisk = rd
        }
        return b
      },
      maxDuration: (s: number) => {
        config.maxDurationSeconds = s
        builderCalls.push('maxDuration')
        return b
      },
      replace: () => {
        config.replaced = true
        builderCalls.push('replace')
        return b
      },
      envs: (vars: Record<string, string>) => {
        Object.assign(config.env, vars)
        builderCalls.push('envs')
        return b
      },
      workdir: (p: string) => {
        config.workdir = p
        builderCalls.push('workdir')
        return b
      },
      user: (u: string) => {
        config.user = u
        builderCalls.push('user')
        return b
      },
      network: (configure: (n: { policy: (p: unknown) => unknown }) => unknown) => {
        const n = {
          policy: (p: unknown) => {
            config.network = p as RecordedPolicy
            return n
          },
        }
        configure(n)
        builderCalls.push('network')
        return b
      },
      secret: (
        configure: (s: {
          env: (v: string) => unknown
          value: (v: string) => unknown
          allowHost: (h: string) => unknown
        }) => unknown,
      ) => {
        const entry: RecordedSecret = { env: '', value: '', allowedHosts: [] }
        const sb = {
          env: (v: string) => {
            entry.env = v
            return sb
          },
          value: (v: string) => {
            entry.value = v
            return sb
          },
          allowHost: (h: string) => {
            entry.allowedHosts.push(h)
            return sb
          },
        }
        configure(sb)
        config.secrets.push(entry)
        builderCalls.push('secret')
        return b
      },
      volume: (
        guest: string,
        configure: (m: { named: (name: string) => unknown; readonly: () => unknown }) => unknown,
      ) => {
        const mount: RecordedVolume = { guest, name: '', readonly: false }
        const m = {
          named: (volumeName: string) => {
            mount.name = volumeName
            return m
          },
          readonly: () => {
            mount.readonly = true
            return m
          },
        }
        configure(m)
        config.volumes.push(mount)
        builderCalls.push('volume')
        return b
      },
      create: async () => {
        builderCalls.push('create')
        if (hooks.onCreate) {
          return hooks.onCreate(config)
        }
        return {
          name: config.name,
          execStreamWith: async (
            command: string,
            configureExec: (b: FakeExecOptionsBuilder) => FakeExecOptionsBuilder,
          ) => {
            const { builder: execBuilder, recorded } = makeExecOptionsBuilder()
            configureExec(execBuilder)
            if (hooks.onExec) {
              return hooks.onExec(config, command, recorded)
            }
            return makeExecHandle([{ kind: 'exited', code: 0 }])
          },
          fs: () => ({
            copyFromHost: async () => {},
            copyToHost: async () => {},
            write: async () => {},
            readToString: async () => 'content',
          }),
          metrics: async () => ({ memoryHostResidentBytes: 10, memoryBytes: 20, cpuPercent: 5 }),
          stopWithTimeout: async () => {},
        }
      },
    }
    return b
  }

  const sdk = {
    Sandbox: {
      builder: (name: string) => sandboxBuilder(name),
      get: async (name: string) => {
        if (hooks.onGet) {
          return hooks.onGet(name)
        }
        return {
          name,
          stop: async () => {},
          snapshot: async (snapName: string) => ({ name: snapName, sizeBytes: null }),
        }
      },
      listWith: async (configure: (b: { limit: (n: number) => unknown }) => unknown) => {
        let limit = 0
        configure({
          limit: (n: number) => {
            limit = n
            return { limit: () => {} }
          },
        })
        void limit
        return hooks.onListWith ? hooks.onListWith() : { sandboxes: [] }
      },
      remove: async (name: string) => {
        hooks.onSandboxRemove?.(name)
      },
    },
    Volume: {
      builder: (name: string) => {
        let kind: 'disk' | 'directory' = 'directory'
        let sizeMib: number | undefined
        const vb = {
          disk: () => {
            kind = 'disk'
            return vb
          },
          directory: () => {
            kind = 'directory'
            return vb
          },
          size: (mib: number) => {
            sizeMib = mib
            return vb
          },
          create: async () => {
            hooks.onVolumeCreate?.(name, kind, sizeMib)
            return {}
          },
        }
        return vb
      },
      remove: async (name: string) => {
        hooks.onVolumeRemove?.(name)
      },
    },
    Snapshot: {
      list: async () => (hooks.onSnapshotList ? hooks.onSnapshotList() : []),
      remove: async (name: string, opts?: { force?: boolean }) => {
        hooks.onSnapshotRemove?.(name, opts)
      },
    },
    NetworkPolicy: { builder: policyBuilder },
    MiB: (n: number) => n,
  }

  return { sdk, builderCalls }
}

function sdkError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

// --- createMicrosandboxDriver: probe ------------------------------------------

describe('createMicrosandboxDriver.probe', () => {
  test('available with an injected sdk on a host with /dev/kvm access', async () => {
    const { sdk } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    const probe = await driver.probe()
    expect(probe.available).toBe(true)
    expect(probe.reason).toBeNull()
  })

  test('surfaces the microsandbox SDK version from its own package.json regardless of the injected sdk', async () => {
    const { sdk } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    const probe = await driver.probe()
    expect(probe.version).toBe('0.6.15')
  })
})

// --- createMicrosandboxDriver: create ------------------------------------------

describe('createMicrosandboxDriver.create', () => {
  test('rejects image and fromSnapshot together before touching the SDK', async () => {
    const { sdk, builderCalls } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    await expect(
      driver.create(baseSpec({ image: 'node:26', fromSnapshot: 'snap-1' })),
    ).rejects.toThrow(/exactly one of image or fromSnapshot/)
    expect(builderCalls).toEqual([])
  })

  test('rejects neither image nor fromSnapshot before touching the SDK', async () => {
    const { sdk, builderCalls } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    const spec = { ...baseSpec(), image: undefined } as unknown as SandboxSpec
    await expect(driver.create(spec)).rejects.toThrow(/exactly one of image or fromSnapshot/)
    expect(builderCalls).toEqual([])
  })

  test('rejects a missing network policy before touching the SDK', async () => {
    const { sdk, builderCalls } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    const spec = { ...baseSpec(), network: undefined } as unknown as SandboxSpec
    await expect(driver.create(spec)).rejects.toThrow(/SandboxSpec.network is required/)
    expect(builderCalls).toEqual([])
  })

  test('rejects a non-array allowedDomains before touching the SDK', async () => {
    const { sdk, builderCalls } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    const spec = {
      ...baseSpec(),
      network: { allowedDomains: 'api.anthropic.com' },
    } as unknown as SandboxSpec
    await expect(driver.create(spec)).rejects.toThrow(/SandboxSpec.network is required/)
    expect(builderCalls).toEqual([])
  })

  test('applies a deny-by-default, port-443, exact-domain network policy for an image sandbox', async () => {
    let captured: RecordedSandboxConfig | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => {
        captured = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(
      baseSpec({ network: { allowedDomains: ['api.anthropic.com', 'platform.claude.com'] } }),
    )
    expect(captured?.network).toEqual({
      defaultEgress: 'deny',
      defaultIngress: 'allow',
      rules: [
        { domain: 'api.anthropic.com', port: 443 },
        { domain: 'platform.claude.com', port: 443 },
      ],
    })
  })

  test('an empty allowlist still attaches a deny-total policy (no rules)', async () => {
    let captured: RecordedSandboxConfig | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => {
        captured = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(baseSpec({ network: { allowedDomains: [] } }))
    expect(captured?.network).toEqual({ defaultEgress: 'deny', defaultIngress: 'allow', rules: [] })
  })

  test('applies the same network policy on a fromSnapshot sandbox (never optional)', async () => {
    let captured: RecordedSandboxConfig | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => {
        captured = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(snapshotSpec())
    expect(captured?.fromSnapshot).toBe('snap-1')
    expect(captured?.image).toBeUndefined()
    expect(captured?.network?.defaultEgress).toBe('deny')
    expect(captured?.network?.rules).toEqual([{ domain: 'api.anthropic.com', port: 443 }])
  })

  test('always calls replace()', async () => {
    const { sdk, builderCalls } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(baseSpec())
    expect(builderCalls).toContain('replace')
  })

  test('secrets are declared on the sandbox builder, never through network()', async () => {
    let captured: RecordedSandboxConfig | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => {
        captured = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(
      baseSpec({
        secrets: [
          {
            env: 'CLAUDE_CODE_OAUTH_TOKEN',
            value: 'tok',
            allowedHosts: ['api.anthropic.com', 'platform.claude.com'],
          },
        ],
      }),
    )
    expect(captured?.secrets).toEqual([
      {
        env: 'CLAUDE_CODE_OAUTH_TOKEN',
        value: 'tok',
        allowedHosts: ['api.anthropic.com', 'platform.claude.com'],
      },
    ])
    // The network policy carries only egress rules, never the secret itself.
    expect(JSON.stringify(captured?.network)).not.toContain('tok')
  })

  test('managed vs flat root disk are both wired through rootDisk()', async () => {
    let managed: RecordedSandboxConfig | undefined
    let flat: RecordedSandboxConfig | undefined
    const managedSdk = makeFakeSdk({
      onCreate: (config) => {
        managed = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    }).sdk
    const flatSdk = makeFakeSdk({
      onCreate: (config) => {
        flat = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    }).sdk
    await createMicrosandboxDriver({ sdk: managedSdk }).create(
      baseSpec({ rootDisk: { kind: 'managed', sizeMib: 6144 } }),
    )
    await createMicrosandboxDriver({ sdk: flatSdk }).create(
      baseSpec({ rootDisk: { kind: 'flat', sizeMib: 10_240 } }),
    )
    expect(managed?.rootDisk).toEqual({ kind: 'managed', sizeMib: 6144 })
    expect(flat?.rootDisk).toEqual({ kind: 'flat', sizeMib: 10_240 })
  })

  test('env, workdir, user and volumes are wired through', async () => {
    let captured: RecordedSandboxConfig | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => {
        captured = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(
      baseSpec({
        env: { FOO: 'bar' },
        workdir: '/work',
        user: 'agent',
        volumes: [
          { guest: '/work', name: 'codesema-home-t1' },
          { guest: '/cache', name: 'codesema-cache', readonly: true },
        ],
      }),
    )
    expect(captured?.env).toEqual({ FOO: 'bar' })
    expect(captured?.workdir).toBe('/work')
    expect(captured?.user).toBe('agent')
    expect(captured?.volumes).toEqual([
      { guest: '/work', name: 'codesema-home-t1', readonly: false },
      { guest: '/cache', name: 'codesema-cache', readonly: true },
    ])
  })

  test('cpus, memory and maxDuration are forwarded as given', async () => {
    let captured: RecordedSandboxConfig | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => {
        captured = config
        return {
          name: config.name,
          execStreamWith: async () => makeExecHandle([]),
          fs: () => ({}) as never,
          metrics: async () => ({
            memoryHostResidentBytes: null,
            memoryBytes: null,
            cpuPercent: null,
          }),
          stopWithTimeout: async () => {},
        }
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.create(baseSpec({ cpus: 4, memoryMib: 8192, maxDurationSeconds: 900 }))
    expect(captured?.cpus).toBe(4)
    expect(captured?.memoryMib).toBe(8192)
    expect(captured?.maxDurationSeconds).toBe(900)
  })
})

// --- createMicrosandboxDriver: exec/shell --------------------------------------

describe('createMicrosandboxDriver exec/shell', () => {
  function driverWithExec(onExec: NonNullable<FakeSdkHooks['onExec']>): SandboxDriver {
    const { sdk } = makeFakeSdk({ onExec })
    return createMicrosandboxDriver({ sdk })
  }

  test('args, cwd, user, env and timeout are forwarded to the exec options builder', async () => {
    let captured: RecordedExecOptions | undefined
    const driver = driverWithExec((_config, _command, opts) => {
      captured = opts
      return makeExecHandle([{ kind: 'exited', code: 0 }])
    })
    const handle = await driver.create(baseSpec())
    await handle.exec('git', ['status', '--short'], {
      timeoutMs: 30_000,
      cwd: '/work',
      user: 'agent',
      env: { FOO: 'bar' },
    })
    expect(captured).toMatchObject({
      args: ['status', '--short'],
      cwd: '/work',
      user: 'agent',
      env: { FOO: 'bar' },
      timeoutMs: 30_000,
      stdin: 'null',
    })
  })

  test('input is sent as stdinBytes, verbatim', async () => {
    let captured: RecordedExecOptions | undefined
    const driver = driverWithExec((_config, _command, opts) => {
      captured = opts
      return makeExecHandle([{ kind: 'exited', code: 0 }])
    })
    const handle = await driver.create(baseSpec())
    await handle.exec('claude', ['-p'], { timeoutMs: 5_000, input: 'do the thing' })
    expect(captured?.stdin).toBe('bytes')
    expect(captured?.stdinText).toBe('do the thing')
  })

  test('stdout and stderr events are collected and streamed to onText in order', async () => {
    const driver = driverWithExec(() =>
      makeExecHandle([
        textEvent('stdout', 'a'),
        textEvent('stderr', 'b'),
        textEvent('stdout', 'c'),
        { kind: 'exited', code: 0 },
      ]),
    )
    const handle = await driver.create(baseSpec())
    const chunks: string[] = []
    const result = await handle.exec('cmd', [], { timeoutMs: 5_000, onText: (c) => chunks.push(c) })
    expect(chunks).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ code: 0, stdout: 'ac', stderr: 'b', timedOut: false })
  })

  test('an execTimeout SDK error becomes timedOut: true with whatever output was captured', async () => {
    const driver = driverWithExec(() =>
      makeExecHandle([textEvent('stdout', 'partial')], {
        throwOnIterate: sdkError('execTimeout', 'timed out'),
      }),
    )
    const handle = await driver.create(baseSpec())
    const result = await handle.exec('slow', [], { timeoutMs: 1_000 })
    expect(result).toEqual({ code: null, stdout: 'partial', stderr: '', timedOut: true })
  })

  test('a non-timeout SDK error propagates', async () => {
    const driver = driverWithExec(() => makeExecHandle([], { throwOnIterate: new Error('boom') }))
    const handle = await driver.create(baseSpec())
    await expect(handle.exec('cmd', [], { timeoutMs: 5_000 })).rejects.toThrow('boom')
  })

  test('an already-aborted signal kills the exec handle before it yields anything', async () => {
    let killed = false
    const controller = new AbortController()
    const driver = driverWithExec(() =>
      makeExecHandle([{ kind: 'exited', code: 0 }], {
        onKill: () => {
          killed = true
        },
      }),
    )
    const handle = await driver.create(baseSpec())
    controller.abort()
    const result = await handle.exec('sleep', ['10'], {
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    expect(killed).toBe(true)
    expect(result.code).toBeNull()
  })

  test('aborting mid-stream kills the exec handle and stops draining further events', async () => {
    let killed = false
    const controller = new AbortController()
    const driver = driverWithExec(() => {
      const handle = makeExecHandle([textEvent('stdout', 'before'), textEvent('stdout', 'after')], {
        onKill: () => {
          killed = true
        },
      })
      // Abort right as the consumer starts iterating (after the first
      // yielded event), same as a watchdog reacting to the "before" chunk.
      const originalIterator = handle[Symbol.asyncIterator]
      return {
        ...handle,
        [Symbol.asyncIterator]: () => {
          const inner = originalIterator()
          return {
            next: async () => {
              const step = await inner.next()
              if (!step.done && step.value.kind === 'stdout') {
                controller.abort()
              }
              return step
            },
          }
        },
      }
    })
    const handle = await driver.create(baseSpec())
    const chunks: string[] = []
    const result = await handle.exec('sleep', ['10'], {
      timeoutMs: 5_000,
      signal: controller.signal,
      onText: (c) => chunks.push(c),
    })
    expect(killed).toBe(true)
    expect(chunks).toEqual(['before'])
    expect(result.stdout).toBe('before')
  })

  test('shell() routes through `sh -lc <script>`, since shellStream takes no options', async () => {
    let seenCommand: string | undefined
    let seenArgs: string[] | undefined
    const driver = driverWithExec((_config, command, opts) => {
      seenCommand = command
      seenArgs = opts.args
      return makeExecHandle([{ kind: 'exited', code: 0 }])
    })
    const handle = await driver.create(baseSpec())
    await handle.shell('claude -p "hi there"', { timeoutMs: 5_000 })
    expect(seenCommand).toBe('sh')
    expect(seenArgs).toEqual(['-lc', 'claude -p "hi there"'])
  })
})

// --- createMicrosandboxDriver: fs / metrics / stop -----------------------------

describe('createMicrosandboxDriver fs/metrics/stop', () => {
  test('metrics maps the SDK shape 1:1', async () => {
    const { sdk } = makeFakeSdk({
      onCreate: (config) => ({
        name: config.name,
        execStreamWith: async () => makeExecHandle([]),
        fs: () => ({}) as never,
        metrics: async () => ({ memoryHostResidentBytes: 111, memoryBytes: 222, cpuPercent: 12.5 }),
        stopWithTimeout: async () => {},
      }),
    })
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    expect(await handle.metrics()).toEqual({
      memoryHostResidentBytes: 111,
      memoryBytes: 222,
      cpuPercent: 12.5,
    })
  })

  test('stop calls stopWithTimeout(10_000)', async () => {
    let seenTimeout: number | undefined
    const { sdk } = makeFakeSdk({
      onCreate: (config) => ({
        name: config.name,
        execStreamWith: async () => makeExecHandle([]),
        fs: () => ({}) as never,
        metrics: async () => ({
          memoryHostResidentBytes: null,
          memoryBytes: null,
          cpuPercent: null,
        }),
        stopWithTimeout: async (ms: number) => {
          seenTimeout = ms
        },
      }),
    })
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await handle.stop()
    expect(seenTimeout).toBe(10_000)
  })

  test('writeFile/readFile delegate to sandbox.fs()', async () => {
    const fsCalls: string[] = []
    const { sdk } = makeFakeSdk({
      onCreate: (config) => ({
        name: config.name,
        execStreamWith: async () => makeExecHandle([]),
        fs: () => ({
          copyFromHost: async () => {},
          copyToHost: async () => {},
          write: async (p: string, d: string) => {
            fsCalls.push(`write:${p}:${d}`)
          },
          readToString: async (p: string) => {
            fsCalls.push(`readToString:${p}`)
            return 'contents'
          },
        }),
        metrics: async () => ({
          memoryHostResidentBytes: null,
          memoryBytes: null,
          cpuPercent: null,
        }),
        stopWithTimeout: async () => {},
      }),
    })
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await handle.writeFile('/g/c', 'hi')
    expect(await handle.readFile('/g/c')).toBe('contents')
    expect(fsCalls).toEqual(['write:/g/c:hi', 'readToString:/g/c'])
  })
})

// --- createMicrosandboxDriver: copyFromHost/copyToHost directory trees --------
//
// `SdkFsOps.copyFromHost`/`copyToHost` only move a single file (the SDK's own
// README example uses one, and a directory host path fails with EISDIR in the
// real SDK, see microsandbox-driver.ts `copyTreeFromHost` for the spike that
// found it). Every real caller in this codebase passes a worktree (a
// directory), so the driver tars on one side and untars on the other; these
// tests exercise that workaround directly, with a real `tar` binary and real
// temp files on the host side (not a full guest, which the fake SDK cannot
// provide).

type FakeCopyFs = {
  copyFromHost?: (hostPath: string, guestPath: string) => Promise<void>
  copyToHost?: (guestPath: string, hostPath: string) => Promise<void>
}

/** Wires a fake sandbox whose `execStreamWith` routes straight to `execHandler`, no `onCreate`/`onExec` plumbing needed at each call site. */
function fakeSdkWithExec(
  execHandler: (
    command: string,
    execOpts: RecordedExecOptions,
  ) => ReturnType<typeof makeExecHandle>,
  fsOverrides: FakeCopyFs = {},
) {
  const { sdk } = makeFakeSdk({
    onCreate: (config) => ({
      name: config.name,
      execStreamWith: async (
        command: string,
        configureExec: (b: FakeExecOptionsBuilder) => FakeExecOptionsBuilder,
      ) => {
        const { builder, recorded } = makeExecOptionsBuilder()
        configureExec(builder)
        return execHandler(command, recorded)
      },
      fs: () => ({
        copyFromHost: async () => {},
        copyToHost: async () => {},
        write: async () => {},
        readToString: async () => '',
        ...fsOverrides,
      }),
      metrics: async () => ({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
      stopWithTimeout: async () => {},
    }),
  })
  return sdk
}

describe('createMicrosandboxDriver copyFromHost/copyToHost: directory trees via tar', () => {
  test('copyFromHost on a plain file still delegates straight to sandbox.fs()', async () => {
    const hostDir = makeDir()
    const hostFile = join(hostDir, 'note.txt')
    writeFileSync(hostFile, 'hello')
    const fsCalls: string[] = []
    const { sdk } = makeFakeSdk({
      onCreate: (config) => ({
        name: config.name,
        execStreamWith: async () => makeExecHandle([]),
        fs: () => ({
          copyFromHost: async (h: string, g: string) => {
            fsCalls.push(`copyFromHost:${h}:${g}`)
          },
          copyToHost: async () => {},
          write: async () => {},
          readToString: async () => '',
        }),
        metrics: async () => ({
          memoryHostResidentBytes: null,
          memoryBytes: null,
          cpuPercent: null,
        }),
        stopWithTimeout: async () => {},
      }),
    })
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await handle.copyFromHost(hostFile, '/g/note.txt')
    expect(fsCalls).toEqual([`copyFromHost:${hostFile}:/g/note.txt`])
  })

  test('copyFromHost on a directory tars it on the host and untars it inside the guest', async () => {
    const hostDir = makeDir()
    writeFileSync(join(hostDir, 'a.txt'), 'a')
    mkdirSync(join(hostDir, 'sub'))
    writeFileSync(join(hostDir, 'sub', 'b.txt'), 'b')
    const execScripts: string[] = []
    let copiedTarHostPath: string | undefined
    let copiedTarExistedAtCallTime = false
    const sdk = fakeSdkWithExec(
      (_command, execOpts) => {
        execScripts.push(execOpts.args[1] ?? '')
        return makeExecHandle([{ kind: 'exited', code: 0 }])
      },
      {
        copyFromHost: async (h) => {
          copiedTarHostPath = h
          copiedTarExistedAtCallTime = existsSync(h)
        },
      },
    )
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await handle.copyFromHost(hostDir, '/work')
    expect(copiedTarExistedAtCallTime).toBe(true)
    expect(copiedTarHostPath).toMatch(/\.tar$/)
    const untarScript = execScripts.find((s) => s.includes('tar -xf'))
    expect(untarScript).toContain("mkdir -p '/work'")
    expect(untarScript).toContain("-C '/work'")
  })

  test('copyFromHost on a directory throws when the guest untar fails', async () => {
    const hostDir = makeDir()
    writeFileSync(join(hostDir, 'a.txt'), 'a')
    const sdk = fakeSdkWithExec(() => makeExecHandle([{ kind: 'exited', code: 1 }]))
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await expect(handle.copyFromHost(hostDir, '/work')).rejects.toThrow(/guest untar failed/)
  })

  test('copyToHost on a non-directory guest path still delegates straight to sandbox.fs()', async () => {
    const hostDir = makeDir()
    const hostFile = join(hostDir, 'out.txt')
    const fsCalls: string[] = []
    const sdk = fakeSdkWithExec(() => makeExecHandle([{ kind: 'exited', code: 1 }]), {
      copyToHost: async (g, h) => {
        fsCalls.push(`copyToHost:${g}:${h}`)
      },
    })
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await handle.copyToHost('/g/out.txt', hostFile)
    expect(fsCalls).toEqual([`copyToHost:/g/out.txt:${hostFile}`])
  })

  test('copyToHost on a directory tars it inside the guest and untars it on the host', async () => {
    const sourceDir = makeDir()
    writeFileSync(join(sourceDir, 'result.txt'), 'built')
    const localTar = join(makeDir(), 'guest-content.tar')
    execFileSync('tar', ['-cf', localTar, '-C', sourceDir, '.'])
    const destDir = join(makeDir(), 'dest')
    const execScripts: string[] = []
    const sdk = fakeSdkWithExec(
      (_command, execOpts) => {
        execScripts.push(execOpts.args[1] ?? '')
        return makeExecHandle([{ kind: 'exited', code: 0 }])
      },
      {
        copyToHost: async (_g, h) => {
          writeFileSync(h, readFileSync(localTar))
        },
      },
    )
    const handle = await createMicrosandboxDriver({ sdk }).create(baseSpec())
    await handle.copyToHost('/work', destDir)
    expect(existsSync(join(destDir, 'result.txt'))).toBe(true)
    expect(readFileSync(join(destDir, 'result.txt'), 'utf8')).toBe('built')
    expect(execScripts.some((s) => s.startsWith('[ -d'))).toBe(true)
    expect(execScripts.some((s) => s.includes('tar -cf'))).toBe(true)
  })
})

// --- createMicrosandboxDriver: snapshot / listSandboxes / listSnapshots --------

describe('createMicrosandboxDriver snapshot and listing', () => {
  test('snapshot goes through Sandbox.get(name).snapshot(snapshotName)', async () => {
    let gotName: string | undefined
    let snapName: string | undefined
    const { sdk } = makeFakeSdk({
      onGet: (name) => {
        gotName = name
        return {
          name,
          stop: async () => {},
          snapshot: async (n: string) => {
            snapName = n
            return { sizeBytes: 12345n }
          },
        }
      },
    })
    const info = await createMicrosandboxDriver({ sdk }).snapshot(
      sandboxName('dev', 't1'),
      'snap-1',
    )
    expect(gotName).toBe(sandboxName('dev', 't1'))
    expect(snapName).toBe('snap-1')
    expect(info).toEqual({ name: 'snap-1', sizeBytes: 12345 })
  })

  test('a null sizeBytes stays null', async () => {
    const { sdk } = makeFakeSdk({
      onGet: () => ({
        name: 'x',
        stop: async () => {},
        snapshot: async () => ({ sizeBytes: null }),
      }),
    })
    const info = await createMicrosandboxDriver({ sdk }).snapshot('x', 'snap-1')
    expect(info.sizeBytes).toBeNull()
  })

  test('the flat-root-disk SDK error message is preserved verbatim', async () => {
    const { sdk } = makeFakeSdk({
      onGet: () => ({
        name: 'x',
        stop: async () => {},
        snapshot: async () => {
          throw new Error('sandbox uses a flat root disk, which is not yet supported by snapshots')
        },
      }),
    })
    await expect(createMicrosandboxDriver({ sdk }).snapshot('x', 'snap-1')).rejects.toThrow(
      'sandbox uses a flat root disk, which is not yet supported by snapshots',
    )
  })

  test('listSandboxes filters to the codesema- prefix', async () => {
    const { sdk } = makeFakeSdk({
      onListWith: () => ({
        sandboxes: [
          { name: sandboxName('dev', 'a') },
          { name: 'someone-elses-box' },
          { name: sandboxName('checks', 'b') },
        ],
      }),
    })
    const names = await createMicrosandboxDriver({ sdk }).listSandboxes()
    expect(names).toEqual([sandboxName('dev', 'a'), sandboxName('checks', 'b')])
  })

  test('listSnapshots drops digest-only (unnamed) entries and converts bigint sizes', async () => {
    const { sdk } = makeFakeSdk({
      onSnapshotList: () => [
        { name: 'snap-1', sizeBytes: 2048n },
        { name: null, sizeBytes: 999n },
        { name: 'snap-2', sizeBytes: null },
      ],
    })
    const infos = await createMicrosandboxDriver({ sdk }).listSnapshots()
    expect(infos).toEqual([
      { name: 'snap-1', sizeBytes: 2048 },
      { name: 'snap-2', sizeBytes: null },
    ])
  })

  test('removeSnapshot forces removal', async () => {
    let seen: { name: string; opts: { force?: boolean } | undefined } | undefined
    const { sdk } = makeFakeSdk({
      onSnapshotRemove: (name, opts) => {
        seen = { name, opts }
      },
    })
    await createMicrosandboxDriver({ sdk }).removeSnapshot('snap-1')
    expect(seen).toEqual({ name: 'snap-1', opts: { force: true } })
  })
})

// --- createMicrosandboxDriver: ensureVolume / removeVolume ---------------------

describe('createMicrosandboxDriver volumes', () => {
  test('ensureVolume wires kind and size, and is idempotent on VolumeAlreadyExists', async () => {
    const created: { name: string; kind: string; sizeMib: number | undefined }[] = []
    const { sdk } = makeFakeSdk({
      onVolumeCreate: (name, kind, sizeMib) => {
        created.push({ name, kind, sizeMib })
      },
    })
    const driver = createMicrosandboxDriver({ sdk })
    await driver.ensureVolume('vol-1', { kind: 'disk', sizeMib: 2048 })
    expect(created).toEqual([{ name: 'vol-1', kind: 'disk', sizeMib: 2048 }])

    const alreadyExists = makeFakeSdk({
      onVolumeCreate: () => {
        throw sdkError('volumeAlreadyExists', 'already exists')
      },
    }).sdk
    await expect(
      createMicrosandboxDriver({ sdk: alreadyExists }).ensureVolume('vol-1', { kind: 'directory' }),
    ).resolves.toBeUndefined()
  })

  test('ensureVolume propagates any other error', async () => {
    const { sdk } = makeFakeSdk({
      onVolumeCreate: () => {
        throw sdkError('io', 'disk full')
      },
    })
    await expect(
      createMicrosandboxDriver({ sdk }).ensureVolume('vol-1', { kind: 'disk' }),
    ).rejects.toThrow('disk full')
  })

  test('removeVolume delegates to Volume.remove', async () => {
    let removed: string | undefined
    const { sdk } = makeFakeSdk({
      onVolumeRemove: (name) => {
        removed = name
      },
    })
    await createMicrosandboxDriver({ sdk }).removeVolume('vol-1')
    expect(removed).toBe('vol-1')
  })
})

// --- createMicrosandboxDriver: destroy -----------------------------------------

describe('createMicrosandboxDriver.destroy', () => {
  test('stops the sandbox then removes it via the static Sandbox.remove', async () => {
    let stopped = false
    let removed: string | undefined
    const { sdk } = makeFakeSdk({
      onGet: (name) => ({
        name,
        stop: async () => {
          stopped = true
        },
        snapshot: async () => ({ sizeBytes: null }),
      }),
      onSandboxRemove: (name) => {
        removed = name
      },
    })
    await createMicrosandboxDriver({ sdk, onNotice: () => {} }).destroy('codesema-dev-t1')
    expect(stopped).toBe(true)
    expect(removed).toBe('codesema-dev-t1')
  })

  test('ignores a stop() failure and still removes the sandbox', async () => {
    let removed: string | undefined
    const { sdk } = makeFakeSdk({
      onGet: (name) => ({
        name,
        stop: async () => {
          throw new Error('not running')
        },
        snapshot: async () => ({ sizeBytes: null }),
      }),
      onSandboxRemove: (name) => {
        removed = name
      },
    })
    await expect(
      createMicrosandboxDriver({ sdk, onNotice: () => {} }).destroy('codesema-dev-t1'),
    ).resolves.toBeUndefined()
    expect(removed).toBe('codesema-dev-t1')
  })

  test('a sandboxNotFound on get() still attempts the static remove', async () => {
    let removed: string | undefined
    const { sdk } = makeFakeSdk({
      onGet: () => {
        throw sdkError('sandboxNotFound', 'no such sandbox')
      },
      onSandboxRemove: (name) => {
        removed = name
      },
    })
    await expect(
      createMicrosandboxDriver({ sdk, onNotice: () => {} }).destroy('codesema-dev-t1'),
    ).resolves.toBeUndefined()
    expect(removed).toBe('codesema-dev-t1')
  })

  test('a non-notFound error on get() propagates', async () => {
    const { sdk } = makeFakeSdk({
      onGet: () => {
        throw sdkError('io', 'daemon unreachable')
      },
    })
    await expect(createMicrosandboxDriver({ sdk }).destroy('codesema-dev-t1')).rejects.toThrow(
      'daemon unreachable',
    )
  })

  test('a sandboxNotFound on remove() is swallowed', async () => {
    const { sdk } = makeFakeSdk({
      onGet: (name) => ({
        name,
        stop: async () => {},
        snapshot: async () => ({ sizeBytes: null }),
      }),
      onSandboxRemove: () => {
        throw sdkError('sandboxNotFound', 'already gone')
      },
    })
    await expect(
      createMicrosandboxDriver({ sdk, onNotice: () => {} }).destroy('codesema-dev-t1'),
    ).resolves.toBeUndefined()
  })

  test('a non-notFound error on remove() propagates', async () => {
    const { sdk } = makeFakeSdk({
      onGet: (name) => ({
        name,
        stop: async () => {},
        snapshot: async () => ({ sizeBytes: null }),
      }),
      onSandboxRemove: () => {
        throw sdkError('io', 'remove failed')
      },
    })
    await expect(createMicrosandboxDriver({ sdk }).destroy('codesema-dev-t1')).rejects.toThrow(
      'remove failed',
    )
  })
})

// --- destroy: real sqlite store purge ------------------------------------------

describe('destroy purges the sandbox store', () => {
  let msbHome: string
  let originalMsbHome: string | undefined

  beforeEach(() => {
    msbHome = makeDir('codesema-msb-home-')
    mkdirSync(join(msbHome, 'db'), { recursive: true })
    originalMsbHome = process.env.MSB_HOME
    process.env.MSB_HOME = msbHome
  })

  afterEach(() => {
    if (originalMsbHome === undefined) {
      delete process.env.MSB_HOME
    } else {
      process.env.MSB_HOME = originalMsbHome
    }
  })

  function dbPath(): string {
    return join(msbHome, 'db', 'msb.db')
  }

  test('deletes rows naming the destroyed sandbox from every table with a name/sandbox column, and leaves others', async () => {
    const db = new Database(dbPath())
    db.run('CREATE TABLE secrets (id INTEGER PRIMARY KEY, sandbox TEXT, value TEXT)')
    db.run('CREATE TABLE sandboxes (id INTEGER PRIMARY KEY, name TEXT)')
    db.run('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT)')
    db.run("INSERT INTO secrets (sandbox, value) VALUES ('codesema-dev-t1', 'sk-ant-oat01-secret')")
    db.run("INSERT INTO secrets (sandbox, value) VALUES ('codesema-dev-other', 'kept')")
    db.run("INSERT INTO sandboxes (name) VALUES ('codesema-dev-t1')")
    db.run("INSERT INTO sandboxes (name) VALUES ('codesema-dev-other')")
    db.run("INSERT INTO unrelated (note) VALUES ('codesema-dev-t1 mentioned in passing')")
    db.close()

    const { sdk } = makeFakeSdk({
      onGet: () => {
        throw sdkError('sandboxNotFound', 'gone')
      },
      onSandboxRemove: () => {
        throw sdkError('sandboxNotFound', 'gone')
      },
    })
    await createMicrosandboxDriver({ sdk }).destroy('codesema-dev-t1')

    const after = new Database(dbPath())
    const secrets = after.query('SELECT sandbox, value FROM secrets').all() as {
      sandbox: string
      value: string
    }[]
    const sandboxes = after.query('SELECT name FROM sandboxes').all() as { name: string }[]
    after.close()

    expect(secrets).toEqual([{ sandbox: 'codesema-dev-other', value: 'kept' }])
    expect(sandboxes).toEqual([{ name: 'codesema-dev-other' }])
  })

  test('never throws when the db file does not exist', async () => {
    rmSync(dbPath(), { force: true })
    expect(existsSync(dbPath())).toBe(false)
    const { sdk } = makeFakeSdk({
      onGet: () => {
        throw sdkError('sandboxNotFound', 'gone')
      },
      onSandboxRemove: () => {
        throw sdkError('sandboxNotFound', 'gone')
      },
    })
    await expect(
      createMicrosandboxDriver({ sdk }).destroy('codesema-dev-t1'),
    ).resolves.toBeUndefined()
  })

  test('reports a purge failure through onNotice instead of throwing', async () => {
    // A directory where the db file should be makes `new Database(path)` fail.
    rmSync(dbPath(), { force: true })
    mkdirSync(dbPath())
    const notices: string[] = []
    const { sdk } = makeFakeSdk({
      onGet: () => {
        throw sdkError('sandboxNotFound', 'gone')
      },
      onSandboxRemove: () => {
        throw sdkError('sandboxNotFound', 'gone')
      },
    })
    await createMicrosandboxDriver({ sdk, onNotice: (n) => notices.push(n) }).destroy(
      'codesema-dev-t1',
    )
    expect(notices.some((n) => n.includes('sandbox store purge skipped'))).toBe(true)
  })
})

// --- shell/exec structural sanity: SandboxHandle satisfies the interface ------

describe('SandboxHandle shape', () => {
  test('the handle returned by the real driver satisfies SandboxHandle', async () => {
    const { sdk } = makeFakeSdk()
    const driver = createMicrosandboxDriver({ sdk })
    const handle: SandboxHandle = await driver.create(baseSpec())
    expect(handle.name).toBe(baseSpec().name)
    expect(typeof handle.exec).toBe('function')
    expect(typeof handle.shell).toBe('function')
    expect(typeof handle.copyFromHost).toBe('function')
    expect(typeof handle.copyToHost).toBe('function')
    expect(typeof handle.writeFile).toBe('function')
    expect(typeof handle.readFile).toBe('function')
    expect(typeof handle.metrics).toBe('function')
    expect(typeof handle.stop).toBe('function')
  })
})
