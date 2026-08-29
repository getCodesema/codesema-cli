/**
 * The virtualization seam of the microvm isolation mode: everything the runner
 * needs from a microVM runtime, and nothing the runtime happens to offer.
 * Microsandbox is the first driver; the fake one is what every other module
 * tests against, so nothing outside this file depends on the SDK.
 *
 * Guard rails fixed by the spike of 2026-08-28 (rapport in the codesema repo,
 * docs/internal/rapports/2026-08-28-spike-microsandbox.md):
 * - a sandbox is NEVER created without a network policy: the SDK opens the
 *   network by default and a snapshot does not carry the policy, so `create`
 *   requires one and re-applies it on every restore;
 * - domain rules are restricted to port 443;
 * - secrets are declared on the SandboxBuilder (`.secret()` / `.secretEnv()`),
 *   never through `network()`, which substitutes nothing;
 * - `destroy` also purges the sandbox's rows from the runtime store, which
 *   keeps secret values in clear after removal;
 * - a flat root disk (required for dockerd) cannot be snapshotted in 0.6.15.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type SandboxRole = 'dev' | 'checks' | 'verify' | 'review' | 'gitops' | 'scan'

export const SANDBOX_NAME_PREFIX = 'codesema-'

/** `codesema-<role>-<taskId>`: the prefix is how the sweep tells ours from everyone else's. */
export function sandboxName(role: SandboxRole, id: string): string {
  return `${SANDBOX_NAME_PREFIX}${role}-${id}`
}

/** Deny by default; exact domains, HTTPS only. */
export type SandboxNetworkPolicy = {
  allowedDomains: readonly string[]
}

/** The real value stays on the host: the guest sees `$MSB_<env>`, the proxy substitutes it toward `allowedHosts` only. */
export type SandboxSecret = {
  env: string
  value: string
  allowedHosts: readonly string[]
}

export type SandboxRootDisk =
  { kind: 'managed'; sizeMib: number } | { kind: 'flat'; sizeMib: number }

export type SandboxVolumeMount = {
  guest: string
  name: string
  readonly?: boolean
}

export type SandboxSpec = {
  name: string
  /** OCI image; exclusive with `fromSnapshot`. */
  image?: string
  fromSnapshot?: string
  cpus: number
  memoryMib: number
  rootDisk?: SandboxRootDisk
  maxDurationSeconds: number
  /** Required on purpose: see the guard rails above. */
  network: SandboxNetworkPolicy
  secrets?: readonly SandboxSecret[]
  env?: Readonly<Record<string, string>>
  volumes?: readonly SandboxVolumeMount[]
  /** Must exist in the image (the SDK refuses a missing workdir at create). */
  workdir?: string
  user?: string
}

export type SandboxExecResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SandboxExecOptions = {
  timeoutMs: number
  cwd?: string
  env?: Readonly<Record<string, string>>
  user?: string
  input?: string
  /** Streamed stdout+stderr chunks, in order. */
  onText?: (chunk: string) => void
  signal?: AbortSignal
}

export type SandboxMetrics = {
  memoryHostResidentBytes: number | null
  memoryBytes: number | null
  cpuPercent: number | null
}

export type SandboxHandle = {
  readonly name: string
  exec(
    command: string,
    args: readonly string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult>
  shell(script: string, opts: SandboxExecOptions): Promise<SandboxExecResult>
  copyFromHost(hostPath: string, guestPath: string): Promise<void>
  copyToHost(guestPath: string, hostPath: string): Promise<void>
  writeFile(guestPath: string, content: string): Promise<void>
  readFile(guestPath: string): Promise<string>
  metrics(): Promise<SandboxMetrics>
  /** Graceful stop; the sandbox still exists (snapshot-able) until `destroy`. */
  stop(): Promise<void>
}

export type SandboxProbe = {
  available: boolean
  /** Readable reason when unavailable (no /dev/kvm, SDK missing, msb doctor red). */
  reason: string | null
  version: string | null
}

export type SnapshotInfo = {
  name: string
  sizeBytes: number | null
}

export type SandboxDriver = {
  readonly kind: 'microsandbox' | 'fake'
  probe(): Promise<SandboxProbe>
  create(spec: SandboxSpec): Promise<SandboxHandle>
  /** The sandbox must be stopped. Refused by the runtime on a flat root disk. */
  snapshot(sandboxName: string, snapshotName: string): Promise<SnapshotInfo>
  listSandboxes(): Promise<string[]>
  listSnapshots(): Promise<SnapshotInfo[]>
  /** Stop if running, remove, purge the runtime store of this sandbox's rows. */
  destroy(sandboxName: string): Promise<void>
  removeSnapshot(snapshotName: string): Promise<void>
  ensureVolume(name: string, opts: { kind: 'disk' | 'directory'; sizeMib?: number }): Promise<void>
  removeVolume(name: string): Promise<void>
}

export type SandboxSweepOptions = {
  driver: SandboxDriver
  /** Task ids still owned by this runner: their sandboxes are never touched. */
  claimedIds: ReadonlySet<string>
  /** Re-checked just before each destroy, same race as the HOME volume sweep. */
  recheckClaimedIds?: () => ReadonlySet<string> | null
}

export type SandboxSweepOutcome = {
  removed: string[]
  notices: string[]
}

const SANDBOX_ROLES: ReadonlySet<SandboxRole> = new Set([
  'dev',
  'checks',
  'verify',
  'review',
  'gitops',
  'scan',
])

/** `codesema-<role>-<id>` -> `<id>`, or `null` when the name is not one of ours. */
function sandboxIdFromName(name: string): string | null {
  if (!name.startsWith(SANDBOX_NAME_PREFIX)) {
    return null
  }
  const rest = name.slice(SANDBOX_NAME_PREFIX.length)
  const dashIndex = rest.indexOf('-')
  if (dashIndex === -1) {
    return null
  }
  const role = rest.slice(0, dashIndex)
  if (!SANDBOX_ROLES.has(role as SandboxRole)) {
    return null
  }
  const id = rest.slice(dashIndex + 1)
  return id.length > 0 ? id : null
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Removes every `codesema-*` sandbox whose task id is no longer claimed.
 * Never throws: every failure becomes a notice.
 */
export async function sweepOrphanedSandboxes(
  opts: SandboxSweepOptions,
): Promise<SandboxSweepOutcome> {
  const removed: string[] = []
  const notices: string[] = []
  let names: string[]
  try {
    names = await opts.driver.listSandboxes()
  } catch (err) {
    return { removed, notices: [`could not list sandboxes: ${errMessage(err)}`] }
  }
  for (const name of names) {
    const id = sandboxIdFromName(name)
    if (id === null) {
      continue
    }
    if (opts.claimedIds.has(id)) {
      continue
    }
    if (opts.recheckClaimedIds) {
      const fresh = opts.recheckClaimedIds()
      if (fresh === null) {
        notices.push(
          `orphaned sandbox ${name} left in place: the claimed-id inventory could not be re-verified right before removing it`,
        )
        continue
      }
      if (fresh.has(id)) {
        continue
      }
    }
    try {
      await opts.driver.destroy(name)
      removed.push(id)
      notices.push(`orphaned sandbox ${name} removed at boot: no task record claims it`)
    } catch (err) {
      notices.push(`orphaned sandbox ${name} could not be removed: ${errMessage(err)}`)
    }
  }
  return { removed, notices }
}

// --- the microsandbox SDK seam ----------------------------------------------
//
// The `microsandbox` package is an optionalDependency (tsdown keeps it
// external): a user without a microVM host never pays for it, and this driver
// never imports it at module load, only inside `probe`/`create`. The minimal
// port below (not the SDK's own classes) is what makes the driver testable —
// a plain object satisfies it, no real `Sandbox`/`Volume`/`Snapshot` instance
// needs to be constructed to exercise the guard rails in a test. The real
// import is cast into it (`as unknown as MicrosandboxSdk`): the cast is safe
// because every member used here is read from the SDK's own `.d.ts`.

type SdkExecOptionsBuilder = {
  args(args: string[]): SdkExecOptionsBuilder
  cwd(cwd: string): SdkExecOptionsBuilder
  user(user: string): SdkExecOptionsBuilder
  env(key: string, value: string): SdkExecOptionsBuilder
  timeout(ms: number): SdkExecOptionsBuilder
  stdinBytes(data: Uint8Array): SdkExecOptionsBuilder
  stdinNull(): SdkExecOptionsBuilder
}

type SdkExecEvent =
  | { kind: 'started'; pid: number }
  | { kind: 'stdout'; data: Uint8Array }
  | { kind: 'stderr'; data: Uint8Array }
  | { kind: 'exited'; code: number }

type SdkExecHandle = AsyncIterable<SdkExecEvent> & {
  kill(): Promise<void>
}

type SdkFsOps = {
  copyFromHost(hostPath: string, guestPath: string): Promise<void>
  copyToHost(guestPath: string, hostPath: string): Promise<void>
  write(path: string, data: string): Promise<void>
  readToString(path: string): Promise<string>
}

type SdkSandboxInstance = {
  readonly name: string
  execStreamWith(
    cmd: string,
    configure: (b: SdkExecOptionsBuilder) => SdkExecOptionsBuilder,
  ): Promise<SdkExecHandle>
  fs(): SdkFsOps
  metrics(): Promise<{
    memoryHostResidentBytes: number | null
    memoryBytes: number | null
    cpuPercent: number | null
  }>
  stopWithTimeout(timeoutMs: number): Promise<void>
}

type SdkRootDiskBuilder = {
  flat(): SdkRootDiskBuilder
  size(mib: number): SdkRootDiskBuilder
}

type SdkNetworkBuilder = {
  policy(policy: unknown): SdkNetworkBuilder
}

type SdkSecretBuilder = {
  env(varName: string): SdkSecretBuilder
  value(value: string): SdkSecretBuilder
  allowHost(host: string): SdkSecretBuilder
}

type SdkMountBuilder = {
  named(name: string): SdkMountBuilder
  readonly(): SdkMountBuilder
}

type SdkSandboxBuilder = {
  image(reference: string): SdkSandboxBuilder
  fromSnapshot(pathOrName: string): SdkSandboxBuilder
  cpus(n: number): SdkSandboxBuilder
  memory(mib: number): SdkSandboxBuilder
  rootDisk(arg: number | ((d: SdkRootDiskBuilder) => SdkRootDiskBuilder)): SdkSandboxBuilder
  maxDuration(secs: number): SdkSandboxBuilder
  replace(): SdkSandboxBuilder
  envs(vars: Record<string, string>): SdkSandboxBuilder
  workdir(path: string): SdkSandboxBuilder
  user(user: string): SdkSandboxBuilder
  network(configure: (n: SdkNetworkBuilder) => SdkNetworkBuilder): SdkSandboxBuilder
  secret(configure: (s: SdkSecretBuilder) => SdkSecretBuilder): SdkSandboxBuilder
  volume(guest: string, configure: (m: SdkMountBuilder) => SdkMountBuilder): SdkSandboxBuilder
  create(): Promise<SdkSandboxInstance>
}

type SdkSandboxHandle = {
  readonly name: string
  stop(): Promise<void>
  snapshot(name: string): Promise<{ sizeBytes: bigint | null }>
}

type SdkSandboxListBuilder = {
  limit(n: number): SdkSandboxListBuilder
}

type SdkSandboxStatic = {
  builder(name: string): SdkSandboxBuilder
  get(name: string): Promise<SdkSandboxHandle>
  listWith(
    configure: (b: SdkSandboxListBuilder) => SdkSandboxListBuilder,
  ): Promise<{ sandboxes: { name: string }[] }>
  remove(name: string): Promise<void>
}

type SdkVolumeBuilder = {
  disk(): SdkVolumeBuilder
  directory(): SdkVolumeBuilder
  size(mib: number): SdkVolumeBuilder
  create(): Promise<unknown>
}

type SdkVolumeStatic = {
  builder(name: string): SdkVolumeBuilder
  remove(name: string): Promise<void>
}

type SdkSnapshotStatic = {
  list(): Promise<{ name: string | null; sizeBytes: bigint | null }[]>
  remove(pathOrName: string, opts?: { force?: boolean }): Promise<void>
}

type SdkRuleBuilder = {
  allowDomain(domain: string): SdkRuleBuilder
  port(port: number): SdkRuleBuilder
}

type SdkNetworkPolicyBuilder = {
  defaultEgress(action: string): SdkNetworkPolicyBuilder
  defaultIngress(action: string): SdkNetworkPolicyBuilder
  egress(configure: (rb: SdkRuleBuilder) => SdkRuleBuilder): SdkNetworkPolicyBuilder
  build(): unknown
}

type MicrosandboxSdk = {
  Sandbox: SdkSandboxStatic
  Volume: SdkVolumeStatic
  Snapshot: SdkSnapshotStatic
  NetworkPolicy: { builder(): SdkNetworkPolicyBuilder }
  MiB: (n: number) => number
}

/** The runtime error code carried by every `MicrosandboxError` subclass (see errors.d.ts). Never `instanceof`: a fake SDK never needs the real classes. */
function errCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

async function loadSdk(opts: MicrosandboxDriverOptions): Promise<MicrosandboxSdk> {
  if (opts.sdk) {
    return opts.sdk as MicrosandboxSdk
  }
  const mod = await import('microsandbox')
  return mod as unknown as MicrosandboxSdk
}

function readSdkVersion(): string | null {
  try {
    const req = createRequire(import.meta.url)
    const pkgPath = req.resolve('microsandbox/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

async function probeMicrosandbox(opts: MicrosandboxDriverOptions): Promise<SandboxProbe> {
  try {
    await loadSdk(opts)
  } catch (err) {
    return {
      available: false,
      reason: `microsandbox SDK is not installed: ${errMessage(err)}`,
      version: null,
    }
  }
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
  } catch (err) {
    return {
      available: false,
      reason: `/dev/kvm is not accessible for read/write: ${errMessage(err)}`,
      version: readSdkVersion(),
    }
  }
  return { available: true, reason: null, version: readSdkVersion() }
}

function buildNetworkPolicy(mod: MicrosandboxSdk, policy: SandboxNetworkPolicy): unknown {
  let builder = mod.NetworkPolicy.builder().defaultEgress('deny').defaultIngress('allow')
  for (const domain of policy.allowedDomains) {
    builder = builder.egress((rb) => rb.allowDomain(domain).port(443))
  }
  return builder.build()
}

function quoteIdentifier(id: string): string {
  return `"${id.replace(/"/g, '""')}"`
}

/**
 * Best-effort purge of this sandbox's rows from `~/.microsandbox/db/msb.db`
 * (or `$MSB_HOME/db/msb.db`): the runtime keeps secret values in clear there
 * after `stop()`/`remove()` (spike, critère 6, "Persistance côté hôte").
 * `destroy` must succeed either way — a failure here is a notice, never a
 * thrown error. `bun:sqlite` is unavailable under a plain Node runtime, which
 * is the common case: that import failure is itself just another notice.
 */
async function purgeSandboxStore(
  sbName: string,
  onNotice: ((notice: string) => void) | undefined,
): Promise<void> {
  const notify = (msg: string): void => {
    onNotice?.(msg)
  }
  const base = process.env.MSB_HOME ?? join(homedir(), '.microsandbox')
  const dbPath = join(base, 'db', 'msb.db')
  if (!existsSync(dbPath)) {
    return
  }
  try {
    const { Database } = await import('bun:sqlite')
    const db = new Database(dbPath)
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
      for (const { name: table } of tables) {
        const columns = db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as {
          name: string
        }[]
        const targetColumns = columns
          .map((c) => c.name)
          .filter((n) => n === 'name' || n === 'sandbox')
        for (const column of targetColumns) {
          try {
            db.query(
              `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} LIKE ?`,
            ).run(`%${sbName}%`)
          } catch (err) {
            notify(`could not purge ${table}.${column} for ${sbName}: ${errMessage(err)}`)
          }
        }
      }
      try {
        db.query('PRAGMA wal_checkpoint(TRUNCATE)').run()
      } catch (err) {
        notify(`wal checkpoint failed after purging ${sbName}: ${errMessage(err)}`)
      }
    } finally {
      db.close()
    }
  } catch (err) {
    notify(`sandbox store purge skipped for ${sbName}: ${errMessage(err)}`)
  }
}

async function runSdkExec(
  sandbox: SdkSandboxInstance,
  command: string,
  args: string[],
  execOpts: SandboxExecOptions,
): Promise<SandboxExecResult> {
  const handle = await sandbox.execStreamWith(command, (b) => {
    let bb = b.args(args).timeout(execOpts.timeoutMs)
    if (execOpts.cwd) {
      bb = bb.cwd(execOpts.cwd)
    }
    if (execOpts.user) {
      bb = bb.user(execOpts.user)
    }
    if (execOpts.env) {
      for (const [key, value] of Object.entries(execOpts.env)) {
        bb = bb.env(key, value)
      }
    }
    bb =
      execOpts.input !== undefined
        ? bb.stdinBytes(new TextEncoder().encode(execOpts.input))
        : bb.stdinNull()
    return bb
  })
  const onAbort = (): void => {
    void handle.kill()
  }
  if (execOpts.signal?.aborted) {
    onAbort()
  } else {
    execOpts.signal?.addEventListener('abort', onAbort)
  }
  const decoder = new TextDecoder()
  let stdout = ''
  let stderr = ''
  let code: number | null = null
  try {
    for await (const event of handle) {
      if (event.kind === 'stdout') {
        const chunk = decoder.decode(event.data, { stream: true })
        stdout += chunk
        execOpts.onText?.(chunk)
      } else if (event.kind === 'stderr') {
        const chunk = decoder.decode(event.data, { stream: true })
        stderr += chunk
        execOpts.onText?.(chunk)
      } else if (event.kind === 'exited') {
        code = event.code
      }
    }
  } catch (err) {
    if (errCode(err) === 'execTimeout') {
      return { code: null, stdout, stderr, timedOut: true }
    }
    throw err
  } finally {
    execOpts.signal?.removeEventListener('abort', onAbort)
  }
  return { code, stdout, stderr, timedOut: false }
}

/** Single-quote a value for a POSIX shell argument. */
function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** Generous but bounded: a worktree's tar/untar inside the guest, not an install. */
const TREE_COPY_TIMEOUT_MS = 5 * 60_000

/**
 * `SdkFsOps.copyFromHost`/`copyToHost` only move a single FILE (confirmed
 * against the SDK's own README example and BootStart-free in the spike):
 * given a directory host path they fail with `EISDIR`. Every caller in this
 * codebase passes a worktree (a directory), so this tars it on the host,
 * copies the archive as one file, and untars it inside the guest.
 */
async function copyTreeFromHost(
  sandbox: SdkSandboxInstance,
  hostPath: string,
  guestPath: string,
): Promise<void> {
  if (!statSync(hostPath).isDirectory()) {
    await sandbox.fs().copyFromHost(hostPath, guestPath)
    return
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'codesema-microvm-copy-'))
  const hostTar = join(tmpDir, 'tree.tar')
  const guestTar = `/tmp/codesema-copy-in-${randomBytes(8).toString('hex')}.tar`
  try {
    execFileSync('tar', ['-cf', hostTar, '-C', hostPath, '.'])
    await sandbox.fs().copyFromHost(hostTar, guestTar)
    const result = await runSdkExec(
      sandbox,
      'sh',
      [
        '-lc',
        `mkdir -p ${shQuote(guestPath)} && tar -xf ${shQuote(guestTar)} -C ${shQuote(guestPath)} && rm -f ${shQuote(guestTar)}`,
      ],
      { timeoutMs: TREE_COPY_TIMEOUT_MS },
    )
    if (result.code !== 0 || result.timedOut) {
      throw new Error(
        `copyFromHost: guest untar failed: ${(result.stdout + result.stderr).slice(-2000)}`,
      )
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Guest-side counterpart of `copyTreeFromHost`: same EISDIR limit, mirrored the other way. */
async function copyTreeToHost(
  sandbox: SdkSandboxInstance,
  guestPath: string,
  hostPath: string,
): Promise<void> {
  const probe = await runSdkExec(sandbox, 'sh', ['-lc', `[ -d ${shQuote(guestPath)} ]`], {
    timeoutMs: 30_000,
  })
  if (probe.code !== 0) {
    await sandbox.fs().copyToHost(guestPath, hostPath)
    return
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'codesema-microvm-copy-'))
  const hostTar = join(tmpDir, 'tree.tar')
  const guestTar = `/tmp/codesema-copy-out-${randomBytes(8).toString('hex')}.tar`
  try {
    const tarResult = await runSdkExec(
      sandbox,
      'sh',
      ['-lc', `tar -cf ${shQuote(guestTar)} -C ${shQuote(guestPath)} .`],
      { timeoutMs: TREE_COPY_TIMEOUT_MS },
    )
    if (tarResult.code !== 0 || tarResult.timedOut) {
      throw new Error(
        `copyToHost: guest tar failed: ${(tarResult.stdout + tarResult.stderr).slice(-2000)}`,
      )
    }
    await sandbox.fs().copyToHost(guestTar, hostTar)
    mkdirSync(hostPath, { recursive: true })
    execFileSync('tar', ['-xf', hostTar, '-C', hostPath])
    await runSdkExec(sandbox, 'sh', ['-lc', `rm -f ${shQuote(guestTar)}`], { timeoutMs: 30_000 })
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function wrapSdkSandbox(sandbox: SdkSandboxInstance): SandboxHandle {
  return {
    name: sandbox.name,
    exec: (command, args, execOpts) => runSdkExec(sandbox, command, [...args], execOpts),
    // The SDK's own `shellStream` takes no options (no cwd/env/user/timeout),
    // unlike `execStreamWith` — see internal/napi.d.ts. Routing through `sh
    // -lc` on top of `exec` is what gives `shell()` the same option surface.
    shell: (script, execOpts) => runSdkExec(sandbox, 'sh', ['-lc', script], execOpts),
    copyFromHost: (hostPath, guestPath) => copyTreeFromHost(sandbox, hostPath, guestPath),
    copyToHost: (guestPath, hostPath) => copyTreeToHost(sandbox, guestPath, hostPath),
    writeFile: (guestPath, content) => sandbox.fs().write(guestPath, content),
    readFile: (guestPath) => sandbox.fs().readToString(guestPath),
    metrics: async () => {
      const m = await sandbox.metrics()
      return {
        memoryHostResidentBytes: m.memoryHostResidentBytes,
        memoryBytes: m.memoryBytes,
        cpuPercent: m.cpuPercent,
      }
    },
    stop: () => sandbox.stopWithTimeout(10_000),
  }
}

async function createMicrosandboxSandbox(
  spec: SandboxSpec,
  opts: MicrosandboxDriverOptions,
): Promise<SandboxHandle> {
  if (!spec.network || !Array.isArray(spec.network.allowedDomains)) {
    throw new Error('SandboxSpec.network is required')
  }
  const hasImage = spec.image !== undefined
  const hasSnapshot = spec.fromSnapshot !== undefined
  if (hasImage === hasSnapshot) {
    throw new Error('SandboxSpec requires exactly one of image or fromSnapshot')
  }
  const mod = await loadSdk(opts)
  let builder = mod.Sandbox.builder(spec.name)
  builder = hasImage
    ? builder.image(spec.image as string)
    : builder.fromSnapshot(spec.fromSnapshot as string)
  builder = builder
    .cpus(spec.cpus)
    .memory(mod.MiB(spec.memoryMib))
    .maxDuration(spec.maxDurationSeconds)
    .replace()
  const rootDisk = spec.rootDisk
  if (rootDisk) {
    builder =
      rootDisk.kind === 'managed'
        ? builder.rootDisk(rootDisk.sizeMib)
        : builder.rootDisk((d) => d.flat().size(rootDisk.sizeMib))
  }
  builder = builder.network((n) => n.policy(buildNetworkPolicy(mod, spec.network)))
  for (const secret of spec.secrets ?? []) {
    builder = builder.secret((s) => {
      let sb = s.env(secret.env).value(secret.value)
      for (const host of secret.allowedHosts) {
        sb = sb.allowHost(host)
      }
      return sb
    })
  }
  if (spec.env) {
    builder = builder.envs({ ...spec.env })
  }
  if (spec.workdir) {
    builder = builder.workdir(spec.workdir)
  }
  if (spec.user) {
    builder = builder.user(spec.user)
  }
  for (const mount of spec.volumes ?? []) {
    builder = builder.volume(mount.guest, (m) => {
      const named = m.named(mount.name)
      return mount.readonly ? named.readonly() : named
    })
  }
  const sandbox = await builder.create()
  return wrapSdkSandbox(sandbox)
}

async function snapshotMicrosandbox(
  sbName: string,
  snapshotName: string,
  opts: MicrosandboxDriverOptions,
): Promise<SnapshotInfo> {
  const mod = await loadSdk(opts)
  const handle = await mod.Sandbox.get(sbName)
  const snap = await handle.snapshot(snapshotName)
  return { name: snapshotName, sizeBytes: snap.sizeBytes !== null ? Number(snap.sizeBytes) : null }
}

async function listMicrosandboxes(opts: MicrosandboxDriverOptions): Promise<string[]> {
  const mod = await loadSdk(opts)
  const page = await mod.Sandbox.listWith((b) => b.limit(1000))
  return page.sandboxes.map((s) => s.name).filter((name) => name.startsWith(SANDBOX_NAME_PREFIX))
}

async function listMicrosandboxSnapshots(opts: MicrosandboxDriverOptions): Promise<SnapshotInfo[]> {
  const mod = await loadSdk(opts)
  const handles = await mod.Snapshot.list()
  return handles
    .filter((h): h is { name: string; sizeBytes: bigint | null } => h.name !== null)
    .map((h) => ({ name: h.name, sizeBytes: h.sizeBytes !== null ? Number(h.sizeBytes) : null }))
}

async function destroyMicrosandbox(sbName: string, opts: MicrosandboxDriverOptions): Promise<void> {
  const mod = await loadSdk(opts)
  try {
    const handle = await mod.Sandbox.get(sbName)
    try {
      await handle.stop()
    } catch {
      // best-effort: the sandbox may already be stopped
    }
  } catch (err) {
    if (errCode(err) !== 'sandboxNotFound') {
      throw err
    }
  }
  try {
    await mod.Sandbox.remove(sbName)
  } catch (err) {
    if (errCode(err) !== 'sandboxNotFound') {
      throw err
    }
  }
  await purgeSandboxStore(sbName, opts.onNotice)
}

async function removeMicrosandboxSnapshot(
  snapshotName: string,
  opts: MicrosandboxDriverOptions,
): Promise<void> {
  const mod = await loadSdk(opts)
  await mod.Snapshot.remove(snapshotName, { force: true })
}

async function ensureMicrosandboxVolume(
  name: string,
  volOpts: { kind: 'disk' | 'directory'; sizeMib?: number },
  opts: MicrosandboxDriverOptions,
): Promise<void> {
  const mod = await loadSdk(opts)
  let builder = mod.Volume.builder(name)
  builder = volOpts.kind === 'disk' ? builder.disk() : builder.directory()
  if (volOpts.sizeMib !== undefined) {
    builder = builder.size(volOpts.sizeMib)
  }
  try {
    await builder.create()
  } catch (err) {
    if (errCode(err) !== 'volumeAlreadyExists') {
      throw err
    }
  }
}

async function removeMicrosandboxVolume(
  name: string,
  opts: MicrosandboxDriverOptions,
): Promise<void> {
  const mod = await loadSdk(opts)
  await mod.Volume.remove(name)
}

export type MicrosandboxDriverOptions = {
  /** Override the SDK module (tests, alternate runtime path). */
  sdk?: unknown
  /** Best-effort diagnostics that don't belong in a thrown error (e.g. a skipped store purge). */
  onNotice?: (notice: string) => void
}

/** The real driver, backed by the `microsandbox` SDK (0.6.15, lazily imported). */
export function createMicrosandboxDriver(opts: MicrosandboxDriverOptions = {}): SandboxDriver {
  return {
    kind: 'microsandbox',
    probe: () => probeMicrosandbox(opts),
    create: (spec) => createMicrosandboxSandbox(spec, opts),
    snapshot: (sbName, snapName) => snapshotMicrosandbox(sbName, snapName, opts),
    listSandboxes: () => listMicrosandboxes(opts),
    listSnapshots: () => listMicrosandboxSnapshots(opts),
    destroy: (sbName) => destroyMicrosandbox(sbName, opts),
    removeSnapshot: (snapName) => removeMicrosandboxSnapshot(snapName, opts),
    ensureVolume: (name, volOpts) => ensureMicrosandboxVolume(name, volOpts, opts),
    removeVolume: (name) => removeMicrosandboxVolume(name, opts),
  }
}

export type FakeSandboxCall = {
  method: string
  args: unknown[]
}

export type FakeSandboxState = {
  spec: SandboxSpec
  stopped: boolean
  destroyed: boolean
  execs: { command: string; args: readonly string[]; opts: SandboxExecOptions }[]
  files: Map<string, string>
}

export type FakeExecContext = {
  sandboxName: string
  command: string
  args: readonly string[]
}

export type FakeExecResult = Partial<SandboxExecResult>

export type FakeExecResponder = (ctx: FakeExecContext) => FakeExecResult

export type FakeExecMatcher = (ctx: FakeExecContext) => boolean

export type FakeSandboxDriverOptions = {
  /** Default responder for every exec/shell call that no `script()` entry matches. */
  exec?: FakeExecResponder
  probe?: SandboxProbe
}

type RunExecInput = {
  sandboxName: string
  state: FakeSandboxState
  command: string
  args: readonly string[]
  opts: SandboxExecOptions
}

/**
 * In-memory driver for every test outside lot C1: records calls, answers
 * `exec`/`shell` from a script keyed by command, and refuses the same things
 * the real one refuses (create without policy, snapshot of a running or flat
 * sandbox, image and fromSnapshot together).
 */
export class FakeSandboxDriver implements SandboxDriver {
  readonly kind = 'fake' as const
  readonly calls: FakeSandboxCall[] = []
  readonly sandboxes: Map<string, FakeSandboxState> = new Map()
  readonly snapshots: Map<string, SnapshotInfo> = new Map()
  readonly volumes: Map<string, { kind: 'disk' | 'directory'; sizeMib?: number }> = new Map()

  private readonly defaultExec: FakeExecResponder | undefined
  private readonly probeResult: SandboxProbe
  private readonly scripts: {
    matcher: FakeExecMatcher
    result: FakeExecResult | FakeExecResponder
  }[] = []

  constructor(options: FakeSandboxDriverOptions = {}) {
    this.defaultExec = options.exec
    this.probeResult = options.probe ?? { available: true, reason: null, version: 'fake' }
  }

  /** Registers a scripted response for the first matching exec/shell call; entries are tried in order added. */
  script(matcher: FakeExecMatcher, result: FakeExecResult | FakeExecResponder): this {
    this.scripts.push({ matcher, result })
    return this
  }

  async probe(): Promise<SandboxProbe> {
    this.calls.push({ method: 'probe', args: [] })
    return this.probeResult
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.calls.push({ method: 'create', args: [spec] })
    if (!spec.network) {
      throw new Error('SandboxSpec.network is required')
    }
    const hasImage = spec.image !== undefined
    const hasSnapshot = spec.fromSnapshot !== undefined
    if (hasImage === hasSnapshot) {
      throw new Error('SandboxSpec requires exactly one of image or fromSnapshot')
    }
    const state: FakeSandboxState = {
      spec,
      stopped: false,
      destroyed: false,
      execs: [],
      files: new Map(),
    }
    this.sandboxes.set(spec.name, state)
    return this.buildHandle(spec.name, state)
  }

  async snapshot(sbName: string, snapshotName: string): Promise<SnapshotInfo> {
    this.calls.push({ method: 'snapshot', args: [sbName, snapshotName] })
    const state = this.sandboxes.get(sbName)
    if (!state || state.destroyed) {
      throw new Error(`sandbox not found: ${sbName}`)
    }
    if (!state.stopped) {
      throw new Error(`sandbox is still running: ${sbName}`)
    }
    if (state.spec.rootDisk?.kind === 'flat') {
      throw new Error('sandbox uses a flat root disk, which is not yet supported by snapshots')
    }
    const info: SnapshotInfo = { name: snapshotName, sizeBytes: null }
    this.snapshots.set(snapshotName, info)
    return info
  }

  async listSandboxes(): Promise<string[]> {
    this.calls.push({ method: 'listSandboxes', args: [] })
    return [...this.sandboxes.entries()].filter(([, s]) => !s.destroyed).map(([name]) => name)
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    this.calls.push({ method: 'listSnapshots', args: [] })
    return [...this.snapshots.values()]
  }

  async destroy(sbName: string): Promise<void> {
    this.calls.push({ method: 'destroy', args: [sbName] })
    const state = this.sandboxes.get(sbName)
    if (state) {
      state.stopped = true
      state.destroyed = true
    }
  }

  async removeSnapshot(snapshotName: string): Promise<void> {
    this.calls.push({ method: 'removeSnapshot', args: [snapshotName] })
    this.snapshots.delete(snapshotName)
  }

  async ensureVolume(
    name: string,
    opts: { kind: 'disk' | 'directory'; sizeMib?: number },
  ): Promise<void> {
    this.calls.push({ method: 'ensureVolume', args: [name, opts] })
    if (!this.volumes.has(name)) {
      this.volumes.set(name, opts)
    }
  }

  async removeVolume(name: string): Promise<void> {
    this.calls.push({ method: 'removeVolume', args: [name] })
    this.volumes.delete(name)
  }

  private buildHandle(name: string, state: FakeSandboxState): SandboxHandle {
    return {
      name,
      exec: (command, args, opts) =>
        this.runExec({ sandboxName: name, state, command, args, opts }),
      shell: (script, opts) =>
        this.runExec({ sandboxName: name, state, command: 'sh', args: ['-lc', script], opts }),
      copyFromHost: async (hostPath, guestPath) => {
        this.calls.push({ method: 'copyFromHost', args: [name, hostPath, guestPath] })
      },
      copyToHost: async (guestPath, hostPath) => {
        this.calls.push({ method: 'copyToHost', args: [name, guestPath, hostPath] })
      },
      writeFile: async (guestPath, content) => {
        this.calls.push({ method: 'writeFile', args: [name, guestPath, content] })
        state.files.set(guestPath, content)
      },
      readFile: async (guestPath) => {
        this.calls.push({ method: 'readFile', args: [name, guestPath] })
        const content = state.files.get(guestPath)
        if (content === undefined) {
          throw new Error(`file not found in sandbox ${name}: ${guestPath}`)
        }
        return content
      },
      metrics: async () => {
        this.calls.push({ method: 'metrics', args: [name] })
        return { memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }
      },
      stop: async () => {
        this.calls.push({ method: 'stop', args: [name] })
        state.stopped = true
      },
    }
  }

  private async runExec(input: RunExecInput): Promise<SandboxExecResult> {
    const { sandboxName: sbName, state, command, args, opts } = input
    this.calls.push({ method: 'exec', args: [sbName, command, args] })
    state.execs.push({ command, args, opts })
    const ctx: FakeExecContext = { sandboxName: sbName, command, args }
    let result: SandboxExecResult = { code: 0, stdout: '', stderr: '', timedOut: false }
    const scripted = this.scripts.find((entry) => entry.matcher(ctx))
    if (scripted) {
      const applied = typeof scripted.result === 'function' ? scripted.result(ctx) : scripted.result
      result = { ...result, ...applied }
    } else if (this.defaultExec) {
      result = { ...result, ...this.defaultExec(ctx) }
    }
    if (result.stdout) {
      opts.onText?.(result.stdout)
    }
    if (result.stderr) {
      opts.onText?.(result.stderr)
    }
    return result
  }
}
