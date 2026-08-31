import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureWorkDir,
  loadConfig,
  loadGlobalConfig,
  repoConfigPath,
  saveGlobalConfig,
} from './config.js'

export const RULES_CONTENT_MAX_BYTES = 128 * 1024

export function rulesFilePath(cwd: string): string {
  return join(cwd, '.codesema', 'RULES.md')
}

export function readRulesContent(cwd: string): string {
  const file = rulesFilePath(cwd)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function writeRulesContent(cwd: string, content: string): void {
  ensureWorkDir(cwd)
  writeFileSync(rulesFilePath(cwd), content)
}

export function readSyncAutoPush(cwd: string): boolean {
  return loadConfig(cwd).syncAutoPush ?? false
}

/** syncAutoPush is global-only (config.ts): a repo can never set its own auto-push. */
export function setSyncAutoPush(enabled: boolean): void {
  saveGlobalConfig({ ...loadGlobalConfig(), syncAutoPush: enabled })
}

/**
 * Explicit per-repo checks configuration (.codesema/config.json, key
 * `checks`): when present it REPLACES the automatic detection of the checks
 * engine (task-checks.ts). Repo-only on purpose — the commands run inside a
 * network-less container mounted on the task worktree, never on the host.
 */
export type ChecksConfig = {
  /** Container image; the engine falls back to its default when absent. */
  image?: string
  /** Dependency install step run before the checks; null/absent = none. */
  install?: string | null
  /** Shell commands run sequentially in the container, one check each. */
  commands?: string[]
  /** True: ONLY the install step gets network access; checks never do. Default false. */
  network?: boolean
  /** Per-check timeout; the engine default applies when absent. */
  timeoutSeconds?: number
}

const CHECKS_COMMANDS_MAX = 32
const CHECKS_STRING_MAX = 500

/**
 * Reads the repo's `checks` key. config.ts's parseConfig whitelists its own
 * fields, so the raw file is re-read here; a missing file, invalid JSON or an
 * absent/malformed `checks` key all degrade to null (auto-detection).
 */
export function readChecksConfig(repoRoot: string): ChecksConfig | null {
  const path = repoConfigPath(repoRoot)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const checks = (raw as { checks?: unknown } | null)?.checks
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    return null
  }
  const c = checks as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, CHECKS_STRING_MAX) : undefined
  const image = str(c.image)
  const install = str(c.install)
  const commands = Array.isArray(c.commands)
    ? c.commands
        .filter((cmd): cmd is string => typeof cmd === 'string' && cmd.trim() !== '')
        .map((cmd) => cmd.trim().slice(0, CHECKS_STRING_MAX))
        .slice(0, CHECKS_COMMANDS_MAX)
    : undefined
  return {
    ...(image !== undefined ? { image } : {}),
    // install: null is an explicit "no install step"; absent stays absent.
    ...(install !== undefined ? { install } : c.install === null ? { install: null } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(typeof c.network === 'boolean' ? { network: c.network } : {}),
    ...(Number.isInteger(c.timeoutSeconds) && (c.timeoutSeconds as number) > 0
      ? { timeoutSeconds: c.timeoutSeconds as number }
      : {}),
  }
}

export type ProofConfig = {
  journey: string
  url: string
  timeoutSeconds: number | null
  keep: number | null
}

const PROOF_STRING_MAX = 500
const PROOF_KEEP_MAX = 20

/**
 * Reads the repo's `proof` key. Same raw re-read pattern as readChecksConfig
 * (config.ts's parseConfig whitelists its own fields). journey and url are
 * mandatory: without a journey nothing is replayable, so a missing/invalid
 * one degrades the whole record to null instead of a partial config.
 */
export function readProofConfig(repoRoot: string): ProofConfig | null {
  const path = repoConfigPath(repoRoot)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const proof = (raw as { proof?: unknown } | null)?.proof
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return null
  }
  const p = proof as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, PROOF_STRING_MAX) : undefined
  const journey = str(p.journey)
  const url = str(p.url)
  if (journey === undefined || url === undefined) {
    return null
  }
  const timeoutSeconds =
    Number.isInteger(p.timeoutSeconds) && (p.timeoutSeconds as number) > 0
      ? (p.timeoutSeconds as number)
      : null
  const keep =
    Number.isInteger(p.keep) && (p.keep as number) > 0
      ? Math.min(p.keep as number, PROOF_KEEP_MAX)
      : null
  return { journey, url, timeoutSeconds, keep }
}

/**
 * Writes ONLY the `checks` key of .codesema/config.json, keeping every other
 * key (agent, port, language...) byte-for-byte in place — this is a
 * user-owned file, not codesema's private state. Throws rather than write
 * when the existing file is not a JSON object: overwriting a file we failed
 * to understand would destroy configuration nobody asked us to touch.
 */
export function writeChecksConfig(repoRoot: string, checks: ChecksConfig): string {
  const path = repoConfigPath(repoRoot)
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new Error(`${path} is not valid JSON: refusing to overwrite it`)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${path} is not a JSON object: refusing to overwrite it`)
    }
    existing = raw as Record<string, unknown>
  }
  ensureWorkDir(repoRoot)
  writeFileSync(path, `${JSON.stringify({ ...existing, checks }, null, 2)}\n`)
  return path
}
