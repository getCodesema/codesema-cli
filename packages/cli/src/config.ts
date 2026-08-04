import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isSupportedLanguage, type SupportedLanguage } from './i18n.js'

export type CodesemaConfig = {
  /** Full headless agent shell command (e.g. "claude -p --model opus"). */
  agent?: string | undefined
  /** Wizard metadata, used to re-edit without starting over. */
  agentId?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  target?: string | undefined
  port?: number | undefined
  timeout?: number | undefined
  /** UI and review language (ISO 639-1). */
  language?: SupportedLanguage | undefined
  /** Cloud sync (codesema.com): base URL override and workspace credentials. */
  syncUrl?: string | undefined
  syncWorkspaceId?: string | undefined
  syncSecret?: string | undefined
  /** Explicit opt-in for pushing every completed review; credentials alone never auto-push. */
  syncAutoPush?: boolean | undefined
}

type ConfigScope = 'global' | 'repo'

function parseConfig(path: string, scope: ConfigScope): CodesemaConfig {
  if (!existsSync(path)) {
    return {}
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    return {
      ...(str(raw.agent) ? { agent: str(raw.agent) } : {}),
      ...(str(raw.agentId) ? { agentId: str(raw.agentId) } : {}),
      ...(str(raw.model) ? { model: str(raw.model) } : {}),
      ...(str(raw.effort) ? { effort: str(raw.effort) } : {}),
      ...(str(raw.target) ? { target: str(raw.target) } : {}),
      ...(isSupportedLanguage(raw.language) ? { language: raw.language } : {}),
      // Sync fields are global-only: a cloned repo's .codesema/config.json must
      // never be able to redirect where reviews (diff included) are sent.
      ...(scope === 'global' && str(raw.syncUrl) ? { syncUrl: str(raw.syncUrl) } : {}),
      ...(scope === 'global' && str(raw.syncWorkspaceId)
        ? { syncWorkspaceId: str(raw.syncWorkspaceId) }
        : {}),
      ...(scope === 'global' && str(raw.syncSecret) ? { syncSecret: str(raw.syncSecret) } : {}),
      ...(scope === 'global' && typeof raw.syncAutoPush === 'boolean'
        ? { syncAutoPush: raw.syncAutoPush }
        : {}),
      ...(Number.isInteger(raw.port) ? { port: raw.port as number } : {}),
      ...(Number.isInteger(raw.timeout) ? { timeout: raw.timeout as number } : {}),
    }
  } catch {
    return {}
  }
}

function writeConfig(path: string, config: CodesemaConfig, options?: { mode: number }): string {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, options)
  return path
}

export function globalConfigDir(): string {
  if (process.env.CODESEMA_CONFIG_DIR) {
    return process.env.CODESEMA_CONFIG_DIR
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'codesema')
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), 'config.json')
}

export function loadGlobalConfig(): CodesemaConfig {
  return parseConfig(globalConfigPath(), 'global')
}

export function saveGlobalConfig(config: CodesemaConfig): string {
  mkdirSync(globalConfigDir(), { recursive: true })
  // The global config can hold the sync workspace secret: owner-only permissions,
  // re-tightened on every save because the mode option only applies at creation.
  const path = writeConfig(globalConfigPath(), config, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, '.codesema', 'config.json')
}

export function loadRepoConfig(repoRoot: string): CodesemaConfig {
  return parseConfig(repoConfigPath(repoRoot), 'repo')
}

export function saveRepoConfig(repoRoot: string, config: CodesemaConfig): string {
  ensureWorkDir(repoRoot)
  return writeConfig(repoConfigPath(repoRoot), config)
}

/** Effective config: repo overrides global, field by field. */
export function loadConfig(repoRoot: string | null): CodesemaConfig {
  const global = loadGlobalConfig()
  const repo = repoRoot ? loadRepoConfig(repoRoot) : {}
  return { ...global, ...repo }
}

// Trust store (TOFU) for repo-provided agent commands. Kept in the GLOBAL config,
// out of reach of any cloned repo: an agent command coming from .codesema/config.json
// only runs after explicit approval, and is re-approved whenever it changes.

export function trustStorePath(): string {
  return join(globalConfigDir(), 'trusted-agents.json')
}

function readTrustStore(): Record<string, string> {
  const path = trustStorePath()
  if (!existsSync(path)) {
    return {}
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Whether this exact agent command was already approved for this repo. */
export function isRepoAgentTrusted(repoRoot: string, command: string): boolean {
  return readTrustStore()[repoRoot] === command
}

/** Records approval of a repo-provided agent command (TOFU). */
export function trustRepoAgent(repoRoot: string, command: string): void {
  const store = readTrustStore()
  store[repoRoot] = command
  mkdirSync(globalConfigDir(), { recursive: true })
  writeFileSync(trustStorePath(), `${JSON.stringify(store, null, 2)}\n`)
}

/** Creates .codesema/ with its own auto .gitignore (no impact on the host repo). */
export function ensureWorkDir(repoRoot: string): string {
  const dir = join(repoRoot, '.codesema')
  mkdirSync(dir, { recursive: true })
  const selfIgnore = join(dir, '.gitignore')
  if (!existsSync(selfIgnore)) {
    writeFileSync(selfIgnore, '*\n')
  }
  return dir
}
