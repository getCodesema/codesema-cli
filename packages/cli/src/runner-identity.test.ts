import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  loadOrCreateRunnerIdentity,
  loadRunnerIdentity,
  runnerIdentityHeader,
} from './runner-identity.js'

describe('runner identity', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-runner-identity-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('loadRunnerIdentity never creates a file', () => {
    expect(loadRunnerIdentity()).toBeNull()
    expect(() => statSync(join(configDir, 'runner-identity.json'))).toThrow()
  })

  test('runnerIdentityHeader is empty before any identity exists', () => {
    expect(runnerIdentityHeader()).toEqual({})
  })

  test('loadOrCreateRunnerIdentity creates a 32-byte X25519 identity', () => {
    const identity = loadOrCreateRunnerIdentity()
    expect(identity.publicKey.length).toBe(32)
    expect(identity.privateKey.length).toBe(32)
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is idempotent: a second call returns the same identity', () => {
    const first = loadOrCreateRunnerIdentity()
    const second = loadOrCreateRunnerIdentity()
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.publicKey.equals(first.publicKey)).toBe(true)
    expect(second.privateKey.equals(first.privateKey)).toBe(true)
  })

  test('loadRunnerIdentity reads back what loadOrCreateRunnerIdentity wrote', () => {
    const created = loadOrCreateRunnerIdentity()
    const loaded = loadRunnerIdentity()
    expect(loaded?.fingerprint).toBe(created.fingerprint)
  })

  test('the identity file is created with owner-only permissions', () => {
    loadOrCreateRunnerIdentity()
    const mode = statSync(join(configDir, 'runner-identity.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('runnerIdentityHeader carries the fingerprint once an identity exists', () => {
    const identity = loadOrCreateRunnerIdentity()
    expect(runnerIdentityHeader()).toEqual({ 'x-codesema-runner': identity.fingerprint })
  })

  test('a corrupted identity file makes loadRunnerIdentity return null', () => {
    const path = join(configDir, 'runner-identity.json')
    writeFileSync(path, 'not valid json{{{')
    chmodSync(path, 0o600)
    expect(loadRunnerIdentity()).toBeNull()
  })

  test('loadOrCreateRunnerIdentity regenerates over a corrupted file', () => {
    const path = join(configDir, 'runner-identity.json')
    writeFileSync(path, 'not valid json{{{')
    chmodSync(path, 0o600)
    const identity = loadOrCreateRunnerIdentity()
    expect(identity.publicKey.length).toBe(32)
    expect(loadRunnerIdentity()?.fingerprint).toBe(identity.fingerprint)
  })

  test('a well-formed but wrong-length key in the file is treated as corrupted', () => {
    const path = join(configDir, 'runner-identity.json')
    writeFileSync(
      path,
      JSON.stringify({
        v: 1,
        public_key: Buffer.alloc(10).toString('base64'),
        private_key: Buffer.alloc(32).toString('base64'),
        created_at: new Date().toISOString(),
      }),
    )
    chmodSync(path, 0o600)
    expect(loadRunnerIdentity()).toBeNull()
  })
})
