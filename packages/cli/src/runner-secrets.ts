import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { nodeAtomicWriteIo, writeFileAtomic, type AtomicWriteIo } from './atomic-write.js'

export type RunnerGitIdentity = {
  name: string
  email: string
}

export type RunnerSecretsPayload = {
  v: 1
  secrets: {
    CLAUDE_CODE_OAUTH_TOKEN?: string
    GH_TOKEN?: string
  }
  repo_url?: string
  git_identity?: RunnerGitIdentity
}

/** Commit signature of last resort when neither the payload nor the host carries one. */
export const RUNNER_FALLBACK_GIT_IDENTITY: RunnerGitIdentity = {
  name: 'codesema',
  email: 'noreply@codesema.com',
}

const SECRET_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'] as const
const SECRET_VALUE_MAX = 4096
const REPO_URL_MAX = 2048
const GIT_IDENTITY_NAME_MAX = 128
const GIT_IDENTITY_EMAIL_MAX = 254
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

  let repoUrl: string | undefined
  if (r.repo_url !== undefined) {
    const value = sanitizeBoundedToken(r.repo_url, REPO_URL_MAX)
    if (value === null) {
      return null
    }
    repoUrl = value
  }

  let gitIdentity: RunnerGitIdentity | undefined
  if (r.git_identity !== undefined) {
    if (!r.git_identity || typeof r.git_identity !== 'object') {
      return null
    }
    const rawIdentity = r.git_identity as Record<string, unknown>
    const name = sanitizeBoundedToken(rawIdentity.name, GIT_IDENTITY_NAME_MAX)
    const email = sanitizeBoundedToken(rawIdentity.email, GIT_IDENTITY_EMAIL_MAX)
    if (name === null || email === null) {
      return null
    }
    gitIdentity = { name, email }
  }

  if (Object.keys(secrets).length === 0 && repoUrl === undefined && gitIdentity === undefined) {
    return null
  }

  return {
    v: 1,
    secrets,
    ...(repoUrl !== undefined ? { repo_url: repoUrl } : {}),
    ...(gitIdentity !== undefined ? { git_identity: gitIdentity } : {}),
  }
}

export type GitConfigExecFn = (args: readonly string[]) => void

/**
 * Pins the delivered identity as the machine's global git config: the runner
 * commits every turn itself (task-runner.ts::commitTurn), and a server
 * installed from a bare cloud image has no identity at all, which fails every
 * commit with "Please tell me who you are".
 */
export function applyGitIdentity(identity: RunnerGitIdentity, runGit: GitConfigExecFn): void {
  runGit(['config', '--global', 'user.name', identity.name])
  runGit(['config', '--global', 'user.email', identity.email])
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
