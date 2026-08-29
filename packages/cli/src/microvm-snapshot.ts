/**
 * The warm project snapshot: image + `runbook.install` + `runbook.services`,
 * named after a hash of what invalidates it (lockfiles, compose, runbook.json),
 * rebuilt when the hash changes, older ones purged. Lot C6 implements it.
 *
 * Flat root disks (dockerd) cannot be snapshotted in Microsandbox 0.6.15: for
 * such a runbook `resolveProjectSnapshot` answers `kind: 'cold'`.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalRunbookJson, type RunbookConfig } from './contract.js'
import { sandboxName, type SandboxDriver, type SandboxSpec } from './microsandbox-driver.js'
import { AGENT_INSTALL_DOMAINS, ensureAgentInstalled } from './microvm-bootstrap.js'

export const SNAPSHOT_NAME_PREFIX = 'codesema-'

const LOCKFILE_NAMES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'uv.lock',
  'Cargo.lock',
  'go.sum',
] as const

const INSTALL_TIMEOUT_MS = 15 * 60_000

/** `codesema-<projectId>-<hash>`. */
export function projectSnapshotName(projectId: string, hash: string): string {
  return `${SNAPSHOT_NAME_PREFIX}${projectId}-${hash}`
}

/**
 * sha256 (16 hex) over the lockfiles, the compose file, the canonical runbook
 * and the agent id: a snapshot built for `claude` is never handed to an
 * `opencode` turn, and switching a project's agent rebuilds the snapshot.
 */
export function projectSnapshotFingerprint(
  worktree: string,
  runbook: RunbookConfig,
  agentId: string,
): string {
  const hash = createHash('sha256')
  const lockfileNames = LOCKFILE_NAMES.toSorted()
  for (const name of lockfileNames) {
    let body: Buffer
    try {
      body = readFileSync(join(worktree, name))
    } catch {
      continue
    }
    hash.update(name).update('\0').update(body).update('\0')
  }
  const composeFile = runbook.services.compose_file
  if (composeFile) {
    let body: Buffer
    try {
      body = readFileSync(join(worktree, composeFile))
    } catch {
      body = Buffer.alloc(0)
    }
    hash.update(composeFile).update('\0').update(body).update('\0')
  }
  hash.update(canonicalRunbookJson(runbook))
  hash.update('\0').update(agentId)
  return hash.digest('hex').slice(0, 16)
}

export type ProjectSnapshot =
  | { kind: 'ready'; name: string; hash: string }
  | { kind: 'missing'; name: string; hash: string }
  | { kind: 'cold'; reason: string }

export type ResolveProjectSnapshotOptions = {
  driver: SandboxDriver
  projectId: string
  worktree: string
  runbook: RunbookConfig
  /** The agent this snapshot must be able to run; folds into its fingerprint. */
  agentId: string
}

function requiresFlatDisk(runbook: RunbookConfig): boolean {
  return runbook.services.host_up.length > 0 || runbook.services.compose_file !== null
}

/** Which snapshot to boot from for this project, without building one. */
export async function resolveProjectSnapshot(
  opts: ResolveProjectSnapshotOptions,
): Promise<ProjectSnapshot> {
  const { driver, projectId, worktree, runbook, agentId } = opts
  if (requiresFlatDisk(runbook)) {
    return { kind: 'cold', reason: 'flat root disk cannot be snapshotted (microsandbox 0.6.15)' }
  }
  const hash = projectSnapshotFingerprint(worktree, runbook, agentId)
  const name = projectSnapshotName(projectId, hash)
  const snapshots = await driver.listSnapshots()
  const exists = snapshots.some((snap) => snap.name === name)
  return exists ? { kind: 'ready', name, hash } : { kind: 'missing', name, hash }
}

export type BuildProjectSnapshotOptions = ResolveProjectSnapshotOptions & {
  timeoutMs: number
  onProgress?: (line: string) => void
}

/**
 * Boots the image, runs `runbook.install`, installs the agent CLI so every
 * later boot from this snapshot has it already on the guest PATH, stops,
 * snapshots, purges the project's older snapshots.
 */
export async function buildProjectSnapshot(
  opts: BuildProjectSnapshotOptions,
): Promise<ProjectSnapshot> {
  const { driver, projectId, worktree, runbook, agentId, timeoutMs, onProgress } = opts
  const resolved = await resolveProjectSnapshot(opts)
  if (resolved.kind !== 'missing') {
    return resolved
  }
  const { name, hash } = resolved
  const spec: SandboxSpec = {
    name: sandboxName('scan', `${projectId}-${hash.slice(0, 8)}`),
    image: runbook.image,
    cpus: 4,
    memoryMib: 4096,
    rootDisk: { kind: 'managed', sizeMib: 8192 },
    maxDurationSeconds: Math.ceil(timeoutMs / 1000),
    network: { allowedDomains: Array.from(new Set([...runbook.egress, ...AGENT_INSTALL_DOMAINS])) },
  }
  const handle = await driver.create(spec)
  try {
    await handle.copyFromHost(worktree, '/work')
    for (const command of runbook.install) {
      onProgress?.(command)
      const result = await handle.shell(command, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        cwd: '/work',
        ...(onProgress ? { onText: onProgress } : {}),
      })
      if (result.code !== 0 || result.timedOut) {
        const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-4000)
        throw new Error(`runbook install failed: ${command}\n${tail}`)
      }
    }
    onProgress?.(`installing ${agentId}`)
    await ensureAgentInstalled(handle, agentId, { install: true })
    await handle.stop()
    await driver.snapshot(spec.name, name)
  } finally {
    await driver.destroy(spec.name)
  }
  await purgeProjectSnapshots(driver, projectId, name)
  return { kind: 'ready', name, hash }
}

/** Removes every `codesema-<projectId>-*` snapshot except `keep`. */
export async function purgeProjectSnapshots(
  driver: SandboxDriver,
  projectId: string,
  keep: string | null,
): Promise<string[]> {
  const prefix = `${SNAPSHOT_NAME_PREFIX}${projectId}-`
  const snapshots = await driver.listSnapshots()
  const removed: string[] = []
  for (const snap of snapshots) {
    if (!snap.name.startsWith(prefix) || snap.name === keep) {
      continue
    }
    try {
      await driver.removeSnapshot(snap.name)
      removed.push(snap.name)
    } catch {
      continue
    }
  }
  return removed
}
