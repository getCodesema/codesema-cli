import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CodesemaConfig = {
  /** Full headless agent shell command (e.g. "claude -p --model opus"). */
  agent?: string
  /** Wizard metadata, used to re-edit without starting over. */
  agentId?: string
  model?: string
  effort?: string
  target?: string
  port?: number
  timeout?: number
}

function parseConfig(path: string): CodesemaConfig {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    return {
      ...(str(raw.agent) ? { agent: str(raw.agent) } : {}),
      ...(str(raw.agentId) ? { agentId: str(raw.agentId) } : {}),
      ...(str(raw.model) ? { model: str(raw.model) } : {}),
      ...(str(raw.effort) ? { effort: str(raw.effort) } : {}),
      ...(str(raw.target) ? { target: str(raw.target) } : {}),
      ...(Number.isInteger(raw.port) ? { port: raw.port as number } : {}),
      ...(Number.isInteger(raw.timeout) ? { timeout: raw.timeout as number } : {}),
    }
  } catch {
    return {}
  }
}

function writeConfig(path: string, config: CodesemaConfig): string {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}

export function globalConfigDir(): string {
  if (process.env.CODESEMA_CONFIG_DIR) return process.env.CODESEMA_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'codesema')
}

export function globalConfigPath(): string {
  return join(globalConfigDir(), 'config.json')
}

export function loadGlobalConfig(): CodesemaConfig {
  return parseConfig(globalConfigPath())
}

export function saveGlobalConfig(config: CodesemaConfig): string {
  mkdirSync(globalConfigDir(), { recursive: true })
  return writeConfig(globalConfigPath(), config)
}

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, '.codesema', 'config.json')
}

export function loadRepoConfig(repoRoot: string): CodesemaConfig {
  return parseConfig(repoConfigPath(repoRoot))
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
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') out[key] = value
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
  if (!existsSync(selfIgnore)) writeFileSync(selfIgnore, '*\n')
  return dir
}
