import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globalConfigDir } from './config.js'
import { generateRunnerKeyPair, runnerKeyFingerprint } from './sealed-box.js'

export type RunnerIdentity = {
  publicKey: Buffer
  privateKey: Buffer
  fingerprint: string
}

type StoredRunnerIdentity = {
  v: 1
  public_key: string
  private_key: string
  created_at: string
}

const RAW_KEY_LENGTH = 32

function runnerIdentityPath(): string {
  return join(globalConfigDir(), 'runner-identity.json')
}

export function loadRunnerIdentity(): RunnerIdentity | null {
  const path = runnerIdentityPath()
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (raw.v !== 1 || typeof raw.public_key !== 'string' || typeof raw.private_key !== 'string') {
      return null
    }
    const publicKey = Buffer.from(raw.public_key, 'base64')
    const privateKey = Buffer.from(raw.private_key, 'base64')
    if (publicKey.length !== RAW_KEY_LENGTH || privateKey.length !== RAW_KEY_LENGTH) {
      return null
    }
    return { publicKey, privateKey, fingerprint: runnerKeyFingerprint(publicKey) }
  } catch {
    return null
  }
}

export function loadOrCreateRunnerIdentity(): RunnerIdentity {
  const existing = loadRunnerIdentity()
  if (existing) {
    return existing
  }

  const { publicKey, privateKey } = generateRunnerKeyPair()
  const stored: StoredRunnerIdentity = {
    v: 1,
    public_key: publicKey.toString('base64'),
    private_key: privateKey.toString('base64'),
    created_at: new Date().toISOString(),
  }

  mkdirSync(globalConfigDir(), { recursive: true })
  const path = runnerIdentityPath()
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  // The mode option above only applies when writeFileSync creates the file;
  // re-tighten explicitly in case it overwrote a pre-existing, laxer file.
  chmodSync(path, 0o600)

  return { publicKey, privateKey, fingerprint: runnerKeyFingerprint(publicKey) }
}

export function runnerIdentityHeader(): Record<string, string> {
  const identity = loadRunnerIdentity()
  return identity ? { 'x-codesema-runner': identity.fingerprint } : {}
}
