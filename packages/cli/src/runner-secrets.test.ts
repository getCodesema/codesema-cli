import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyGitIdentity,
  applySecretsToEnvFile,
  sanitizeRunnerSecretsPayload,
} from './runner-secrets.js'

describe('sanitizeRunnerSecretsPayload', () => {
  test('accepts a full valid payload and trims values', () => {
    const result = sanitizeRunnerSecretsPayload({
      v: 1,
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: '  token-a  ', GH_TOKEN: 'token-b' },
      repo_url: ' https://example.com/repo.git ',
    })
    expect(result).toEqual({
      v: 1,
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'token-a', GH_TOKEN: 'token-b' },
      repo_url: 'https://example.com/repo.git',
    })
  })

  test('accepts a partial payload with only one secret and no repo_url', () => {
    const result = sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: 'token-b' } })
    expect(result).toEqual({ v: 1, secrets: { GH_TOKEN: 'token-b' } })
    expect(result?.repo_url).toBeUndefined()
  })

  test('drops an unrecognized secret key while keeping known ones', () => {
    const result = sanitizeRunnerSecretsPayload({
      v: 1,
      secrets: { GH_TOKEN: 'token-b', UNKNOWN_SECRET: 'x' },
    })
    expect(result).toEqual({ v: 1, secrets: { GH_TOKEN: 'token-b' } })
  })

  test('rejects a missing v', () => {
    expect(sanitizeRunnerSecretsPayload({ secrets: { GH_TOKEN: 'x' } })).toBeNull()
  })

  test('rejects a v that is not the number 1', () => {
    expect(sanitizeRunnerSecretsPayload({ v: '1', secrets: { GH_TOKEN: 'x' } })).toBeNull()
    expect(sanitizeRunnerSecretsPayload({ v: 2, secrets: { GH_TOKEN: 'x' } })).toBeNull()
  })

  test('rejects a payload with no non-empty secret', () => {
    expect(sanitizeRunnerSecretsPayload({ v: 1, secrets: {} })).toBeNull()
    expect(sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: '   ' } })).toBeNull()
  })

  test('rejects non-object input', () => {
    expect(sanitizeRunnerSecretsPayload(null)).toBeNull()
    expect(sanitizeRunnerSecretsPayload('nope')).toBeNull()
    expect(sanitizeRunnerSecretsPayload(42)).toBeNull()
    expect(sanitizeRunnerSecretsPayload(undefined)).toBeNull()
  })

  test('rejects a secrets value that is not an object', () => {
    expect(sanitizeRunnerSecretsPayload({ v: 1, secrets: 'GH_TOKEN=x' })).toBeNull()
    expect(sanitizeRunnerSecretsPayload({ v: 1, secrets: null })).toBeNull()
  })

  test('rejects a secret value with the wrong type', () => {
    expect(sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: 12345 } })).toBeNull()
  })

  test('rejects a secret value over the length cap', () => {
    expect(
      sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: 'a'.repeat(4097) } }),
    ).toBeNull()
    expect(
      sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: 'a'.repeat(4096) } }),
    ).not.toBeNull()
  })

  test('rejects a repo_url over the length cap', () => {
    const longUrl = `https://example.com/${'a'.repeat(2048)}`
    expect(
      sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: 'x' }, repo_url: longUrl }),
    ).toBeNull()
  })

  test('rejects a repo_url with the wrong type', () => {
    expect(
      sanitizeRunnerSecretsPayload({ v: 1, secrets: { GH_TOKEN: 'x' }, repo_url: 123 }),
    ).toBeNull()
  })

  test('rejects a secret value carrying an embedded newline (env-file injection guard)', () => {
    expect(
      sanitizeRunnerSecretsPayload({
        v: 1,
        secrets: { GH_TOKEN: 'token\nEVIL_KEY=evil' },
      }),
    ).toBeNull()
  })

  test('rejects a repo_url carrying an embedded control character', () => {
    expect(
      sanitizeRunnerSecretsPayload({
        v: 1,
        secrets: { GH_TOKEN: 'x' },
        repo_url: 'https://example.com/\trepo.git',
      }),
    ).toBeNull()
  })
})

describe('applySecretsToEnvFile', () => {
  const cleanups: string[] = []

  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'codesema-runner-secrets-'))
    cleanups.push(dir)
    return dir
  }

  test('creates the file when it does not exist yet', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'abc' })
    expect(readFileSync(envPath, 'utf8')).toBe('GH_TOKEN=abc\n')
  })

  test('replaces only the passed keys and preserves the others', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    writeFileSync(envPath, 'GH_TOKEN=old\nOTHER_KEY=untouched\n')
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'new' })
    const contents = readFileSync(envPath, 'utf8')
    expect(contents).toContain('GH_TOKEN=new')
    expect(contents).toContain('OTHER_KEY=untouched')
    expect(contents).not.toContain('GH_TOKEN=old')
  })

  test('adds a new key alongside existing ones', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    writeFileSync(envPath, 'OTHER_KEY=untouched\n')
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'abc' })
    const contents = readFileSync(envPath, 'utf8')
    expect(contents).toContain('OTHER_KEY=untouched')
    expect(contents).toContain('GH_TOKEN=abc')
  })

  test('a value containing "=" is preserved verbatim (split on the first "=" only)', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'abc==def' })
    expect(readFileSync(envPath, 'utf8')).toBe('GH_TOKEN=abc==def\n')
  })

  test('writes the file with owner-only permissions', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'abc' })
    const mode = statSync(envPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('re-tightens permissions when overwriting a pre-existing file', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    writeFileSync(envPath, 'GH_TOKEN=old\n', { mode: 0o644 })
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'new' })
    const mode = statSync(envPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('never leaves the temporary file behind', () => {
    const dir = makeDir()
    const envPath = join(dir, 'runner.env')
    applySecretsToEnvFile(envPath, { GH_TOKEN: 'abc' })
    expect(existsSync(`${envPath}.tmp`)).toBe(false)
  })
})

describe('sanitizeRunnerSecretsPayload git_identity', () => {
  test('accepts and trims a git identity next to the secrets', () => {
    const result = sanitizeRunnerSecretsPayload({
      v: 1,
      secrets: { GH_TOKEN: 'token' },
      git_identity: { name: '  Naash ', email: ' naash@example.com ' },
    })
    expect(result?.git_identity).toEqual({ name: 'Naash', email: 'naash@example.com' })
  })

  test('a git identity alone is a valid payload (secrets stay untouched elsewhere)', () => {
    const result = sanitizeRunnerSecretsPayload({
      v: 1,
      secrets: {},
      git_identity: { name: 'Naash', email: 'naash@example.com' },
    })
    expect(result).toEqual({
      v: 1,
      secrets: {},
      git_identity: { name: 'Naash', email: 'naash@example.com' },
    })
  })

  test('a repo_url alone is a valid payload too', () => {
    const result = sanitizeRunnerSecretsPayload({
      v: 1,
      secrets: {},
      repo_url: 'https://example.com/o/r.git',
    })
    expect(result?.repo_url).toBe('https://example.com/o/r.git')
  })

  test('a name carrying a control character rejects the whole payload (git config injection guard)', () => {
    expect(
      sanitizeRunnerSecretsPayload({
        v: 1,
        secrets: { GH_TOKEN: 'token' },
        git_identity: { name: 'a\nb', email: 'naash@example.com' },
      }),
    ).toBeNull()
  })

  test('a half identity (name without email) rejects the payload', () => {
    expect(
      sanitizeRunnerSecretsPayload({
        v: 1,
        secrets: { GH_TOKEN: 'token' },
        git_identity: { name: 'Naash' },
      }),
    ).toBeNull()
  })
})

describe('applyGitIdentity', () => {
  test('pins name and email as global git config, in that order', () => {
    const calls: string[][] = []
    applyGitIdentity({ name: 'Naash', email: 'naash@example.com' }, (args) => calls.push([...args]))
    expect(calls).toEqual([
      ['config', '--global', 'user.name', 'Naash'],
      ['config', '--global', 'user.email', 'naash@example.com'],
    ])
  })
})
