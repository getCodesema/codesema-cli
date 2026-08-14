import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { saveGlobalConfig, saveRepoConfig } from './config.js'
import {
  readChecksConfig,
  readRulesContent,
  readSyncAutoPush,
  rulesFilePath,
  setSyncAutoPush,
  writeRulesContent,
} from './repo-config.js'

describe('repo-config', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-repoconfig-'))
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-repoconfig-repo-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('reads empty content when RULES.md does not exist', () => {
    expect(readRulesContent(repoDir)).toBe('')
  })

  test('writes RULES.md, creating .codesema on demand', () => {
    writeRulesContent(repoDir, '- no any\n- errors carry a cause\n')
    expect(readFileSync(rulesFilePath(repoDir), 'utf8')).toBe('- no any\n- errors carry a cause\n')
    expect(readRulesContent(repoDir)).toBe('- no any\n- errors carry a cause\n')
  })

  test('overwrites existing RULES.md content', () => {
    writeRulesContent(repoDir, '- first\n')
    writeRulesContent(repoDir, '- second\n')
    expect(readRulesContent(repoDir)).toBe('- second\n')
  })

  test('syncAutoPush defaults to false', () => {
    expect(readSyncAutoPush(repoDir)).toBe(false)
  })

  test('setSyncAutoPush writes to the global config and is read back as effective', () => {
    setSyncAutoPush(true)
    expect(readSyncAutoPush(repoDir)).toBe(true)
  })

  test('setSyncAutoPush preserves other global config fields', () => {
    saveGlobalConfig({ syncUrl: 'http://localhost:9080', syncWorkspaceId: 'ws-1' })
    setSyncAutoPush(true)
    expect(readSyncAutoPush(repoDir)).toBe(true)
  })

  test('a repo cannot make its own syncAutoPush true: the global value always wins', () => {
    saveRepoConfig(repoDir, { syncAutoPush: true })
    expect(readSyncAutoPush(repoDir)).toBe(false)
  })
})

describe('readChecksConfig', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-checkscfg-'))
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  const writeRepoConfig = (content: string) => {
    mkdirSync(join(repoDir, '.codesema'), { recursive: true })
    writeFileSync(join(repoDir, '.codesema', 'config.json'), content)
  }

  test('missing file, invalid json or absent checks key: null (auto-detection)', () => {
    expect(readChecksConfig(repoDir)).toBeNull()
    writeRepoConfig('{ not json')
    expect(readChecksConfig(repoDir)).toBeNull()
    writeRepoConfig(JSON.stringify({ agent: 'claude -p' }))
    expect(readChecksConfig(repoDir)).toBeNull()
    writeRepoConfig(JSON.stringify({ checks: 'yes' }))
    expect(readChecksConfig(repoDir)).toBeNull()
    writeRepoConfig(JSON.stringify({ checks: ['npm test'] }))
    expect(readChecksConfig(repoDir)).toBeNull()
  })

  test('a full checks block is read back field by field', () => {
    writeRepoConfig(
      JSON.stringify({
        checks: {
          image: 'golang:1.23',
          install: 'go mod download',
          commands: ['go vet ./...', 'go test ./...'],
          network: true,
          timeoutSeconds: 120,
        },
      }),
    )
    expect(readChecksConfig(repoDir)).toEqual({
      image: 'golang:1.23',
      install: 'go mod download',
      commands: ['go vet ./...', 'go test ./...'],
      network: true,
      timeoutSeconds: 120,
    })
  })

  test('malformed fields are dropped, not guessed', () => {
    writeRepoConfig(
      JSON.stringify({
        checks: {
          image: 42,
          install: ['nope'],
          commands: ['ok', 7, '', '  ', 'also ok'],
          network: 'yes',
          timeoutSeconds: 2.5,
        },
      }),
    )
    expect(readChecksConfig(repoDir)).toEqual({ commands: ['ok', 'also ok'] })
  })

  test('install: null survives as an explicit no-install', () => {
    writeRepoConfig(JSON.stringify({ checks: { install: null, commands: ['make check'] } }))
    expect(readChecksConfig(repoDir)).toEqual({ install: null, commands: ['make check'] })
  })

  test('an empty checks object is tolerated (unconfigured is the engine call)', () => {
    writeRepoConfig(JSON.stringify({ checks: {} }))
    expect(readChecksConfig(repoDir)).toEqual({})
  })
})
