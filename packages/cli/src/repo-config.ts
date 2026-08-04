import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir, loadConfig, loadGlobalConfig, saveGlobalConfig } from './config.js'

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
