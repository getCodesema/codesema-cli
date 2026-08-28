import { describe, expect, test } from 'bun:test'
import runbookScanFailBodySchema from '../fixtures/hub-schemas/runbook-scan-fail.schema.json'
import runbookScanResultBodySchema from '../fixtures/hub-schemas/runbook-scan-result.schema.json'
import {
  canonicalRunbookJson,
  isRunbookRelativePath,
  isRunbookScanStatus,
  isRunbookSha,
  isRunbookValidationStatus,
  RUNBOOK_COMMAND_MAX,
  RUNBOOK_COMMANDS_MAX,
  RUNBOOK_EGRESS_MAX,
  RUNBOOK_IMAGE_MAX,
  RUNBOOK_PATHS_MAX,
  RUNBOOK_VERSION,
  sanitizeRunbookConfig,
  sanitizeRunbookScan,
  sanitizeRunbookValidation,
  type RunbookConfig,
  type RunbookValidation,
} from './runbook.js'
import { validate, type Schema } from './schema-validator.test-helper.js'

const validRunbook: RunbookConfig = {
  version: 1,
  image: 'ghcr.io/acme/dev:1.2.3',
  install: ['bun install --frozen-lockfile', 'bun run build:web'],
  services: {
    host_up: ['dockerd >/var/log/dockerd.log 2>&1 &', 'docker compose up -d'],
    compose_file: 'compose.yaml',
  },
  healthchecks: ['docker compose exec -T db pg_isready -U postgres'],
  tests: ['bun run typecheck', 'bun test'],
  egress: ['registry.npmjs.org', 'deb.debian.org'],
  depends_on_files: ['package.json', 'bun.lock', 'compose.yaml', 'packages/cli/package.json'],
}

describe('sanitizeRunbookConfig', () => {
  test('a valid runbook round-trips unchanged', () => {
    expect(sanitizeRunbookConfig(structuredClone(validRunbook))).toEqual(validRunbook)
  })

  test('non-object input: null', () => {
    expect(sanitizeRunbookConfig(null)).toBeNull()
    expect(sanitizeRunbookConfig('junk')).toBeNull()
    expect(sanitizeRunbookConfig(42)).toBeNull()
    expect(sanitizeRunbookConfig([])).toBeNull()
  })

  test('wrong or missing version: null (a newer schema is never guessed)', () => {
    expect(sanitizeRunbookConfig({ ...validRunbook, version: 2 })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, version: '1' })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, version: undefined })).toBeNull()
    expect(RUNBOOK_VERSION).toBe(1)
  })

  test('no bootable image: null', () => {
    expect(sanitizeRunbookConfig({ ...validRunbook, image: '' })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, image: '   ' })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, image: undefined })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, image: 'has space:1' })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, image: '-leading-dash' })).toBeNull()
    expect(
      sanitizeRunbookConfig({ ...validRunbook, image: 'x'.repeat(RUNBOOK_IMAGE_MAX + 1) }),
    ).toBeNull()
  })

  test('every usual image reference form is accepted', () => {
    for (const image of [
      'node:26',
      'oven/bun:1',
      'docker:dind',
      'ghcr.io/acme/dev:1.2.3',
      'registry.example.com:5000/team/image',
      'node@sha256:' + 'a'.repeat(64),
      'node:26@sha256:' + 'b'.repeat(64),
    ]) {
      expect(sanitizeRunbookConfig({ ...validRunbook, image })?.image).toBe(image)
    }
  })

  test('no test command: null (a runbook without tests proves nothing)', () => {
    expect(sanitizeRunbookConfig({ ...validRunbook, tests: [] })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, tests: ['', '   '] })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, tests: undefined })).toBeNull()
    expect(sanitizeRunbookConfig({ ...validRunbook, tests: 'bun test' })).toBeNull()
  })

  test('empty object with a version, an image and one test: safe defaults everywhere', () => {
    expect(sanitizeRunbookConfig({ version: 1, image: 'node:26', tests: ['bun test'] })).toEqual({
      version: 1,
      image: 'node:26',
      install: [],
      services: { host_up: [], compose_file: null },
      healthchecks: [],
      tests: ['bun test'],
      egress: [],
      depends_on_files: [],
    })
  })

  test('commands: blanks and non-strings dropped, multi-line refused, order kept, bounded', () => {
    const tests = [
      'bun test',
      '',
      42,
      null,
      '  bun run e2e  ',
      'a\nb',
      'x'.repeat(RUNBOOK_COMMAND_MAX + 50),
    ]
    const out = sanitizeRunbookConfig({ ...validRunbook, tests })
    expect(out?.tests).toEqual(['bun test', 'bun run e2e', 'x'.repeat(RUNBOOK_COMMAND_MAX)])
    const many = Array.from({ length: RUNBOOK_COMMANDS_MAX + 5 }, (_, i) => `cmd ${i}`)
    expect(sanitizeRunbookConfig({ ...validRunbook, install: many })?.install).toHaveLength(
      RUNBOOK_COMMANDS_MAX,
    )
  })

  test('services: a malformed block degrades to no service, never to a partial one', () => {
    expect(sanitizeRunbookConfig({ ...validRunbook, services: 'up' })?.services).toEqual({
      host_up: [],
      compose_file: null,
    })
    expect(
      sanitizeRunbookConfig({ ...validRunbook, services: ['docker compose up'] })?.services,
    ).toEqual({
      host_up: [],
      compose_file: null,
    })
    expect(
      sanitizeRunbookConfig({
        ...validRunbook,
        services: { host_up: ['dockerd &'], compose_file: '../x.yaml' },
      })?.services,
    ).toEqual({ host_up: ['dockerd &'], compose_file: null })
  })

  test('egress: exact lowercase hosts only, deduplicated, bounded', () => {
    const egress = [
      'Registry.NPMJS.org',
      'registry.npmjs.org',
      '*.docker.io',
      'https://deb.debian.org',
      'deb.debian.org:443',
      'localhost',
      '1.1.1.1',
      'deb.debian.org',
      '',
      7,
    ]
    expect(sanitizeRunbookConfig({ ...validRunbook, egress })?.egress).toEqual([
      'registry.npmjs.org',
      'deb.debian.org',
    ])
    const many = Array.from({ length: RUNBOOK_EGRESS_MAX + 3 }, (_, i) => `h${i}.example.com`)
    expect(sanitizeRunbookConfig({ ...validRunbook, egress: many })?.egress).toHaveLength(
      RUNBOOK_EGRESS_MAX,
    )
  })

  test('depends_on_files: relative paths only, traversal and absolute refused, deduplicated, bounded', () => {
    const files = [
      'package.json',
      '/etc/passwd',
      '../secrets',
      'a/../b',
      'a//b',
      'C:\\x',
      'dir\\file',
      '~/x',
      ' package.json',
      'package.json',
      'packages/cli/package.json',
    ]
    expect(
      sanitizeRunbookConfig({ ...validRunbook, depends_on_files: files })?.depends_on_files,
    ).toEqual(['package.json', 'packages/cli/package.json'])
    const many = Array.from({ length: RUNBOOK_PATHS_MAX + 2 }, (_, i) => `f${i}.txt`)
    expect(
      sanitizeRunbookConfig({ ...validRunbook, depends_on_files: many })?.depends_on_files,
    ).toHaveLength(RUNBOOK_PATHS_MAX)
  })

  test('unknown keys are dropped, never carried', () => {
    const out = sanitizeRunbookConfig({ ...validRunbook, secrets: ['x'], shell: 'bash' }) as Record<
      string,
      unknown
    >
    expect(out.secrets).toBeUndefined()
    expect(out.shell).toBeUndefined()
  })
})

describe('isRunbookRelativePath', () => {
  test('accepts plain worktree paths', () => {
    expect(isRunbookRelativePath('compose.yaml')).toBe(true)
    expect(isRunbookRelativePath('deploy/compose.yaml')).toBe(true)
    expect(isRunbookRelativePath('.codesema/config.json')).toBe(true)
  })

  test('refuses anything that could leave the worktree', () => {
    for (const p of [
      '',
      ' ',
      '/abs',
      '../up',
      'a/../up',
      'a//b',
      '~/home',
      'C:/x',
      'a\\b',
      'a\0b',
      42,
      null,
    ]) {
      expect(isRunbookRelativePath(p)).toBe(false)
    }
  })
})

describe('canonicalRunbookJson', () => {
  test('is independent of key order and of extra keys, and keeps array order', () => {
    const reordered = sanitizeRunbookConfig({
      depends_on_files: validRunbook.depends_on_files,
      egress: validRunbook.egress,
      tests: validRunbook.tests,
      healthchecks: validRunbook.healthchecks,
      services: { compose_file: 'compose.yaml', host_up: validRunbook.services.host_up },
      install: validRunbook.install,
      image: validRunbook.image,
      version: 1,
      extra: true,
    })
    expect(reordered).not.toBeNull()
    expect(canonicalRunbookJson(reordered as RunbookConfig)).toBe(
      canonicalRunbookJson(validRunbook),
    )
    const swapped = { ...validRunbook, tests: validRunbook.tests.toReversed() }
    expect(canonicalRunbookJson(swapped)).not.toBe(canonicalRunbookJson(validRunbook))
  })

  test('has no whitespace and starts with the version', () => {
    const json = canonicalRunbookJson(validRunbook)
    expect(json).toBe(JSON.stringify(JSON.parse(json)))
    expect(json.startsWith('{"version":1,"image":')).toBe(true)
  })
})

describe('sanitizeRunbookValidation', () => {
  const valid: RunbookValidation = {
    runbook_sha: '0123456789abcdef',
    validated_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    validated_at: '2026-08-28T10:00:00.000Z',
    status: 'valid',
  }

  test('a valid record round-trips unchanged', () => {
    expect(sanitizeRunbookValidation(structuredClone(valid))).toEqual(valid)
  })

  test('non-object input: null', () => {
    expect(sanitizeRunbookValidation(null)).toBeNull()
    expect(sanitizeRunbookValidation('junk')).toBeNull()
    expect(sanitizeRunbookValidation([])).toBeNull()
  })

  test('shas are normalized to lowercase and bounded to their exact shapes', () => {
    expect(
      sanitizeRunbookValidation({
        ...valid,
        runbook_sha: '0123456789ABCDEF',
        validated_sha: 'ABCDEF1',
      }),
    ).toEqual({ ...valid, runbook_sha: '0123456789abcdef', validated_sha: 'abcdef1' })
    expect(sanitizeRunbookValidation({ ...valid, runbook_sha: '0123456789abcde' })).toBeNull()
    expect(sanitizeRunbookValidation({ ...valid, runbook_sha: '0123456789abcdef0' })).toBeNull()
    expect(sanitizeRunbookValidation({ ...valid, validated_sha: 'abc' })).toBeNull()
    expect(sanitizeRunbookValidation({ ...valid, validated_sha: 'g'.repeat(40) })).toBeNull()
  })

  test('unknown status: null; every known status kept', () => {
    expect(sanitizeRunbookValidation({ ...valid, status: 'green' })).toBeNull()
    for (const status of ['valid', 'stale', 'failed'] as const) {
      expect(sanitizeRunbookValidation({ ...valid, status })?.status).toBe(status)
      expect(isRunbookValidationStatus(status)).toBe(true)
    }
    expect(isRunbookValidationStatus('running')).toBe(false)
  })

  test('a missing validated_at is stamped now rather than left empty', () => {
    const out = sanitizeRunbookValidation({ ...valid, validated_at: undefined })
    expect(typeof out?.validated_at).toBe('string')
    expect(Number.isNaN(Date.parse(out?.validated_at ?? ''))).toBe(false)
  })
})

describe('isRunbookSha', () => {
  test('exactly 16 lowercase hex', () => {
    expect(isRunbookSha('0123456789abcdef')).toBe(true)
    expect(isRunbookSha('0123456789ABCDEF')).toBe(false)
    expect(isRunbookSha('0123456789abcde')).toBe(false)
    expect(isRunbookSha(42)).toBe(false)
  })
})

describe('sanitizeRunbookScan', () => {
  const valid = {
    id: '0191f6a0-3b2c-7d4e-8f5a-6b7c8d9e0f1a',
    repo_id: '0191f6a0-3b2c-7d4e-8f5a-6b7c8d9e0f1b',
    repo_full_name: 'acme/web',
    head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    status: 'queued' as const,
    requested_at: '2026-08-28T10:00:00.000Z',
  }

  test('a valid item round-trips unchanged', () => {
    expect(sanitizeRunbookScan(structuredClone(valid))).toEqual(valid)
  })

  test('non-object, bad ids or unknown status: null', () => {
    expect(sanitizeRunbookScan(null)).toBeNull()
    expect(sanitizeRunbookScan({ ...valid, id: '12' })).toBeNull()
    expect(sanitizeRunbookScan({ ...valid, repo_id: undefined })).toBeNull()
    expect(sanitizeRunbookScan({ ...valid, status: 'done' })).toBeNull()
    for (const status of ['queued', 'running', 'completed', 'failed']) {
      expect(isRunbookScanStatus(status)).toBe(true)
    }
    expect(isRunbookScanStatus('canceled')).toBe(false)
  })

  test('a malformed or missing head sha reads as null, never as a guess', () => {
    expect(sanitizeRunbookScan({ ...valid, head_sha: 'zz' })?.head_sha).toBeNull()
    expect(sanitizeRunbookScan({ ...valid, head_sha: undefined })?.head_sha).toBeNull()
    expect(sanitizeRunbookScan({ ...valid, head_sha: 'ABCDEF1' })?.head_sha).toBe('abcdef1')
  })
})

// --- Cross tests: sanitizeRunbookConfig + sanitizeRunbookValidation output
// validates against the hub's published runbook-scan-result.schema.json (the
// body of POST /api/cli/runbook-scans/:id/result), and a plain error message
// against runbook-scan-fail.schema.json. Same local validator as arm.test.ts's
// own cross tests (schema-validator.test-helper.ts): proves the SCHEMA
// against the SANITIZER, not a library's leniency.

const runbookScanResultSchemaErrors = (value: unknown): string[] =>
  validate(value, runbookScanResultBodySchema as Schema, runbookScanResultBodySchema as Schema)

const runbookScanFailSchemaErrors = (value: unknown): string[] =>
  validate(value, runbookScanFailBodySchema as Schema, runbookScanFailBodySchema as Schema)

const validValidationRaw = {
  runbook_sha: '0123456789abcdef',
  validated_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  validated_at: '2026-08-14T10:00:00.000Z',
  status: 'valid',
}

describe('cross test: sanitizeRunbookConfig + sanitizeRunbookValidation output validates against runbook-scan-result.schema.json', () => {
  test('the full nominal body (runbook + validation, log_tail set) validates', () => {
    const runbook = sanitizeRunbookConfig(structuredClone(validRunbook)) as RunbookConfig
    const validation = sanitizeRunbookValidation(
      structuredClone(validValidationRaw),
    ) as RunbookValidation
    expect(
      runbookScanResultSchemaErrors({ runbook, validation, log_tail: 'last output lines\n' }),
    ).toEqual([])
  })

  test('log_tail is optional: the body without it also validates', () => {
    const runbook = sanitizeRunbookConfig(structuredClone(validRunbook)) as RunbookConfig
    const validation = sanitizeRunbookValidation(
      structuredClone(validValidationRaw),
    ) as RunbookValidation
    expect(runbookScanResultSchemaErrors({ runbook, validation })).toEqual([])
  })

  test('every valid RunbookValidationStatus produces a validating body', () => {
    const runbook = sanitizeRunbookConfig(structuredClone(validRunbook)) as RunbookConfig
    for (const status of ['valid', 'stale', 'failed'] as const) {
      const validation = sanitizeRunbookValidation({
        ...validValidationRaw,
        status,
      }) as RunbookValidation
      expect(runbookScanResultSchemaErrors({ runbook, validation })).toEqual([])
    }
  })
})

describe('reverse cross test: runbook-scan-result.schema.json is not looser than the sanitizers accept', () => {
  const BASE_RUNBOOK = {
    version: 1,
    image: 'ghcr.io/acme/dev:1.2.3',
    install: [] as string[],
    services: { host_up: [] as string[], compose_file: null },
    healthchecks: [] as string[],
    tests: ['bun test'],
    egress: [] as string[],
    depends_on_files: [] as string[],
  }
  const BASE_VALIDATION = {
    runbook_sha: '0123456789abcdef',
    validated_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    validated_at: '2026-08-14T10:00:00.000Z',
    status: 'valid',
  }

  test('a wrong runbook version is schema-invalid: sanitizeRunbookConfig never emits one', () => {
    expect(
      runbookScanResultSchemaErrors({
        runbook: { ...BASE_RUNBOOK, version: 2 },
        validation: BASE_VALIDATION,
      }),
    ).not.toEqual([])
  })

  test('an unrecognized validation status is schema-invalid: sanitizeRunbookValidation never emits one', () => {
    expect(
      runbookScanResultSchemaErrors({
        runbook: BASE_RUNBOOK,
        validation: { ...BASE_VALIDATION, status: 'green' },
      }),
    ).not.toEqual([])
  })

  test('a runbook_sha of the wrong shape is schema-invalid: sanitizeRunbookValidation never emits one', () => {
    expect(
      runbookScanResultSchemaErrors({
        runbook: BASE_RUNBOOK,
        validation: { ...BASE_VALIDATION, runbook_sha: 'not-hex' },
      }),
    ).not.toEqual([])
  })
})

describe('anti-drift lock: runbook-scan-result.schema.json nested properties match the sanitizers', () => {
  type NestedSchema = { properties: Record<string, { properties?: Record<string, unknown> }> }

  test('runbook.properties matches sanitizeRunbookConfig output keys', () => {
    const runbook = sanitizeRunbookConfig(structuredClone(validRunbook)) as RunbookConfig
    const schema = runbookScanResultBodySchema as unknown as NestedSchema
    const schemaKeys = Object.keys(schema.properties.runbook?.properties ?? {}).toSorted()
    expect(schemaKeys).toEqual(Object.keys(runbook).toSorted())
  })

  test('validation.properties matches sanitizeRunbookValidation output keys', () => {
    const validation = sanitizeRunbookValidation(
      structuredClone(validValidationRaw),
    ) as RunbookValidation
    const schema = runbookScanResultBodySchema as unknown as NestedSchema
    const schemaKeys = Object.keys(schema.properties.validation?.properties ?? {}).toSorted()
    expect(schemaKeys).toEqual(Object.keys(validation).toSorted())
  })

  test('runbook.services.properties matches sanitizeRunbookConfig services output keys', () => {
    const runbook = sanitizeRunbookConfig(structuredClone(validRunbook)) as RunbookConfig
    const schema = runbookScanResultBodySchema as unknown as {
      properties: { runbook: { properties: { services: { properties: Record<string, unknown> } } } }
    }
    const schemaKeys = Object.keys(
      schema.properties.runbook.properties.services.properties,
    ).toSorted()
    expect(schemaKeys).toEqual(Object.keys(runbook.services).toSorted())
  })
})

describe('cross test: runbook-scan-fail.schema.json', () => {
  test('an error at the schema length bounds (1 and 2000 chars) validates', () => {
    expect(runbookScanFailSchemaErrors({ error: 'x' })).toEqual([])
    expect(runbookScanFailSchemaErrors({ error: 'x'.repeat(2000) })).toEqual([])
  })

  test('an empty or over-length error is schema-invalid', () => {
    expect(runbookScanFailSchemaErrors({ error: '' })).not.toEqual([])
    expect(runbookScanFailSchemaErrors({ error: 'x'.repeat(2001) })).not.toEqual([])
  })

  test('a missing error is schema-invalid', () => {
    expect(runbookScanFailSchemaErrors({})).not.toEqual([])
  })
})
