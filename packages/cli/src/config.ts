// Config à deux niveaux : globale (~/.config/codesema/config.json, onboarding
// une seule fois) et par repo (.codesema/config.json, prioritaire).
// Priorité partout : flag CLI > config repo > config globale > détection/défaut.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CodesemaConfig = {
  /** Commande agent headless complète (ex : "claude -p --model opus"). */
  agent?: string
  /** Métadonnées du wizard, pour rééditer sans repartir de zéro. */
  agentId?: string
  model?: string
  effort?: string
  /** Branche cible par défaut (ex : develop). */
  target?: string
  /** Port préféré du serveur local. */
  port?: number
  /** Budget agent en secondes pour `review`. */
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

/** Config effective : globale écrasée champ par champ par celle du repo. */
export function loadConfig(repoRoot: string | null): CodesemaConfig {
  const global = loadGlobalConfig()
  const repo = repoRoot ? loadRepoConfig(repoRoot) : {}
  return { ...global, ...repo }
}

/** Crée .codesema/ avec son .gitignore auto (aucun impact sur le repo hôte). */
export function ensureWorkDir(repoRoot: string): string {
  const dir = join(repoRoot, '.codesema')
  mkdirSync(dir, { recursive: true })
  const selfIgnore = join(dir, '.gitignore')
  if (!existsSync(selfIgnore)) writeFileSync(selfIgnore, '*\n')
  return dir
}
