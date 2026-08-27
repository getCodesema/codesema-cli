import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { nodeAtomicWriteIo, writeFileAtomic, type AtomicWriteIo } from './atomic-write.js'

export type RunnerSecretsPayload = {
  v: 1
  secrets: {
    CLAUDE_CODE_OAUTH_TOKEN?: string
    GH_TOKEN?: string
  }
  repo_url?: string
}

const SECRET_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'] as const
const SECRET_VALUE_MAX = 4096
const REPO_URL_MAX = 2048
// \p{Cc} covers every Unicode control character (newline, carriage return,
// tab, ...). A secret or URL carrying one is either corrupted or an attempt
// to inject extra lines into the KEY=value env file applySecretsToEnvFile
// writes to, so it is rejected rather than silently flattened.
const HAS_CONTROL_CHARACTERS = /\p{Cc}/u

function sanitizeBoundedToken(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || HAS_CONTROL_CHARACTERS.test(trimmed)) {
    return null
  }
  return trimmed
}

export function sanitizeRunnerSecretsPayload(raw: unknown): RunnerSecretsPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !r.secrets || typeof r.secrets !== 'object') {
    return null
  }

  const rawSecrets = r.secrets as Record<string, unknown>
  const secrets: RunnerSecretsPayload['secrets'] = {}
  for (const key of SECRET_KEYS) {
    if (rawSecrets[key] === undefined) {
      continue
    }
    const value = sanitizeBoundedToken(rawSecrets[key], SECRET_VALUE_MAX)
    if (value === null) {
      return null
    }
    secrets[key] = value
  }
  if (Object.keys(secrets).length === 0) {
    return null
  }

  let repoUrl: string | undefined
  if (r.repo_url !== undefined) {
    const value = sanitizeBoundedToken(r.repo_url, REPO_URL_MAX)
    if (value === null) {
      return null
    }
    repoUrl = value
  }

  return { v: 1, secrets, ...(repoUrl !== undefined ? { repo_url: repoUrl } : {}) }
}

function parseEnvFile(contents: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    if (!key) {
      continue
    }
    entries.set(key, line.slice(separatorIndex + 1))
  }
  return entries
}

function serializeEnvFile(entries: Map<string, string>): string {
  return `${Array.from(entries, ([key, value]) => `${key}=${value}`).join('\n')}\n`
}

export function applySecretsToEnvFile(envPath: string, secrets: Record<string, string>): void {
  const existingContents = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const entries = parseEnvFile(existingContents)
  for (const [key, value] of Object.entries(secrets)) {
    entries.set(key, value)
  }

  const io: AtomicWriteIo = {
    mkdir: nodeAtomicWriteIo.mkdir,
    writeFile: (path, contents) => writeFileSync(path, contents, { mode: 0o600 }),
    rename: nodeAtomicWriteIo.rename,
  }
  writeFileAtomic(envPath, serializeEnvFile(entries), io)
  // Belt-and-suspenders: rename(2) carries the temp file's mode over on POSIX,
  // but re-tighten explicitly rather than rely on that on every platform.
  chmodSync(envPath, 0o600)
}
