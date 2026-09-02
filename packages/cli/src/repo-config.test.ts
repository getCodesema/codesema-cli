import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { saveGlobalConfig, saveRepoConfig } from './config.js'
import {
  readChecksConfig,
  readProofConfig,
  readRulesContent,
  readSyncAutoPush,
  rulesFilePath,
  setSyncAutoPush,
  writeChecksConfig,
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

describe('writeChecksConfig', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-writechecks-'))
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  const configFile = () => join(repoDir, '.codesema', 'config.json')
  const writeRepoConfig = (content: string) => {
    mkdirSync(join(repoDir, '.codesema'), { recursive: true })
    writeFileSync(configFile(), content)
  }

  const checks = {
    image: 'oven/bun:1',
    install: 'bun install --frozen-lockfile',
    commands: ['bun run typecheck', 'bun test'],
    network: true,
    timeoutSeconds: 300,
  }

  test('creates .codesema/config.json on demand and round-trips through readChecksConfig', () => {
    writeChecksConfig(repoDir, checks)
    expect(readChecksConfig(repoDir)).toEqual(checks)
    // Human-editable file: pretty-printed, newline-terminated.
    expect(readFileSync(configFile(), 'utf8').endsWith('}\n')).toBe(true)
  })

  test('every other key of the file survives untouched', () => {
    writeRepoConfig(
      JSON.stringify({ agent: 'claude -p', port: 4400, target: 'main', unknownKey: { a: [1] } }),
    )
    writeChecksConfig(repoDir, checks)
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({
      agent: 'claude -p',
      port: 4400,
      target: 'main',
      unknownKey: { a: [1] },
      checks,
    })
  })

  test('an existing checks key is replaced, not merged', () => {
    writeRepoConfig(JSON.stringify({ checks: { image: 'node:22', commands: ['npm test'] } }))
    writeChecksConfig(repoDir, { commands: ['make check'] })
    expect(readChecksConfig(repoDir)).toEqual({ commands: ['make check'] })
  })

  test('refuses to overwrite a config file it cannot parse', () => {
    writeRepoConfig('{ not json')
    expect(() => writeChecksConfig(repoDir, checks)).toThrow(/not valid JSON/)
    expect(readFileSync(configFile(), 'utf8')).toBe('{ not json')
    writeRepoConfig('["an", "array"]')
    expect(() => writeChecksConfig(repoDir, checks)).toThrow(/not a JSON object/)
  })
})

describe('readProofConfig', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-proofcfg-'))
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  const writeRepoConfig = (content: string) => {
    mkdirSync(join(repoDir, '.codesema'), { recursive: true })
    writeFileSync(join(repoDir, '.codesema', 'config.json'), content)
  }

  test('missing file, invalid json or absent proof key: null', () => {
    expect(readProofConfig(repoDir)).toBeNull()
    writeRepoConfig('{ not json')
    expect(readProofConfig(repoDir)).toBeNull()
    writeRepoConfig(JSON.stringify({ agent: 'claude -p' }))
    expect(readProofConfig(repoDir)).toBeNull()
    writeRepoConfig(JSON.stringify({ proof: 'yes' }))
    expect(readProofConfig(repoDir)).toBeNull()
    writeRepoConfig(JSON.stringify({ proof: ['npm test'] }))
    expect(readProofConfig(repoDir)).toBeNull()
  })

  test('journey missing: journey is null, the record is still valid', () => {
    writeRepoConfig(JSON.stringify({ proof: { url: 'http://localhost:3000' } }))
    expect(readProofConfig(repoDir)).toEqual({
      journey: null,
      url: 'http://localhost:3000',
      timeoutSeconds: null,
      keep: null,
    })
  })

  test('url missing: the whole record is null', () => {
    writeRepoConfig(JSON.stringify({ proof: { journey: 'checkout' } }))
    expect(readProofConfig(repoDir)).toBeNull()
  })

  test('out-of-range timeoutSeconds and keep fall back to null, not the record', () => {
    writeRepoConfig(
      JSON.stringify({
        proof: {
          journey: 'checkout',
          url: 'http://localhost:3000',
          timeoutSeconds: -5,
          keep: 0,
        },
      }),
    )
    expect(readProofConfig(repoDir)).toEqual({
      journey: 'checkout',
      url: 'http://localhost:3000',
      timeoutSeconds: null,
      keep: null,
    })
  })

  test('a full proof block is read back field by field', () => {
    writeRepoConfig(
      JSON.stringify({
        proof: {
          journey: 'checkout',
          url: 'http://localhost:3000',
          timeoutSeconds: 120,
          keep: 5,
        },
      }),
    )
    expect(readProofConfig(repoDir)).toEqual({
      journey: 'checkout',
      url: 'http://localhost:3000',
      timeoutSeconds: 120,
      keep: 5,
    })
  })

  test('keep is capped at 20', () => {
    writeRepoConfig(
      JSON.stringify({
        proof: { journey: 'checkout', url: 'http://localhost:3000', keep: 999 },
      }),
    )
    expect(readProofConfig(repoDir)?.keep).toBe(20)
  })
})
