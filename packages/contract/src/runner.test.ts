import Ajv from 'ajv'
import { describe, expect, test } from 'bun:test'
import runnerRegisterBodySchema from '../fixtures/hub-schemas/runner-register.schema.json'
import runnerSecretBodySchema from '../fixtures/hub-schemas/runner-secret.schema.json'
import {
  RUNNER_FINGERPRINT_LEN,
  RUNNER_NAME_MAX,
  RUNNER_PUBLIC_KEY_B64_LEN,
  RUNNER_TIMESTAMP_MAX,
  runnerListEntrySchema,
  sanitizeRunnerListEntry,
  sanitizeSealedSecretBlob,
  SEALED_BLOB_MAX_B64,
  sealedSecretBlobSchema,
  type RunnerListEntry,
  type SealedSecretBlob,
} from './runner.js'

// --- Fixtures ----------------------------------------------------------------
// Both fingerprints and public keys below are real sha256/base64 output
// (verified against the exact patterns runner.ts compiles), not hand-typed
// hex or base64, so a miscounted literal cannot slip a fixture past its own
// gate.

const FINGERPRINT_A = '4573d6f8f348168f1dd347accfd0d0268cffa812a83362f06e687c07513c708a'.slice(
  0,
  RUNNER_FINGERPRINT_LEN,
)
const FINGERPRINT_B = '28198f53ee68fc724b51fea98097a78112a0873d7bc91c4cffe23659d5f8a09d'.slice(
  0,
  RUNNER_FINGERPRINT_LEN,
)
const PUBLIC_KEY_A = 'lrO9snlYjhUxg3Ca0xs18uU8mu8Qp6/WLJKdB2JyNEc='
const PUBLIC_KEY_B = '/5OVO7JjZ8JYA8W8FsbyuvU0mqP+JrPnEZm7aADMQfY='

const validEntry: RunnerListEntry = {
  name: 'laptop-runner',
  fingerprint: FINGERPRINT_A,
  public_key: PUBLIC_KEY_A,
  last_seen_at: '2026-08-14T10:00:00.000Z',
  has_pending_secret: false,
}

const validBlob: SealedSecretBlob = {
  ciphertext: 'c2VhbGVkLXNlY3JldC1wYXlsb2Fk',
  pushed_at: '2026-08-14T10:00:00.000Z',
}

test('fixtures are exactly the length runner.ts requires', () => {
  expect(FINGERPRINT_A).toHaveLength(RUNNER_FINGERPRINT_LEN)
  expect(FINGERPRINT_B).toHaveLength(RUNNER_FINGERPRINT_LEN)
  expect(PUBLIC_KEY_A).toHaveLength(RUNNER_PUBLIC_KEY_B64_LEN)
  expect(PUBLIC_KEY_B).toHaveLength(RUNNER_PUBLIC_KEY_B64_LEN)
})

test('published bounds are locked to their literal values', () => {
  expect(RUNNER_NAME_MAX).toBe(200)
  expect(RUNNER_FINGERPRINT_LEN).toBe(64)
  expect(RUNNER_PUBLIC_KEY_B64_LEN).toBe(44)
  expect(SEALED_BLOB_MAX_B64).toBe(8192)
  expect(RUNNER_TIMESTAMP_MAX).toBe(40)
})

// --- sanitizeRunnerListEntry ---------------------------------------------------

describe('sanitizeRunnerListEntry', () => {
  test('a valid entry round-trips unchanged', () => {
    expect(sanitizeRunnerListEntry(structuredClone(validEntry))).toEqual(validEntry)
  })

  test('non-object input: null', () => {
    expect(sanitizeRunnerListEntry(null)).toBeNull()
    expect(sanitizeRunnerListEntry(undefined)).toBeNull()
    expect(sanitizeRunnerListEntry('junk')).toBeNull()
    expect(sanitizeRunnerListEntry(42)).toBeNull()
    expect(sanitizeRunnerListEntry([])).toBeNull()
  })

  describe('fingerprint gates the whole record', () => {
    test('a non-string fingerprint drops the WHOLE entry', () => {
      for (const fingerprint of [undefined, null, 42, {}, []]) {
        expect(sanitizeRunnerListEntry({ ...validEntry, fingerprint })).toBeNull()
      }
    })

    test('63 or 65 hex characters is refused, never truncated or padded', () => {
      expect(sanitizeRunnerListEntry({ ...validEntry, fingerprint: 'a'.repeat(63) })).toBeNull()
      expect(sanitizeRunnerListEntry({ ...validEntry, fingerprint: 'a'.repeat(65) })).toBeNull()
    })

    test('uppercase hex is refused, never case-folded', () => {
      expect(
        sanitizeRunnerListEntry({ ...validEntry, fingerprint: FINGERPRINT_A.toUpperCase() }),
      ).toBeNull()
    })

    test('non-hex characters at the exact length are refused', () => {
      const nonHex = `g${FINGERPRINT_A.slice(1)}`
      expect(sanitizeRunnerListEntry({ ...validEntry, fingerprint: nonHex })).toBeNull()
    })

    test('a valid fingerprint is kept byte for byte', () => {
      expect(
        sanitizeRunnerListEntry({ ...validEntry, fingerprint: FINGERPRINT_B })?.fingerprint,
      ).toBe(FINGERPRINT_B)
    })
  })

  describe('public_key gates the whole record', () => {
    test('a non-string public_key drops the WHOLE entry', () => {
      for (const public_key of [undefined, null, 42, {}, []]) {
        expect(sanitizeRunnerListEntry({ ...validEntry, public_key })).toBeNull()
      }
    })

    test('43 or 45 characters is refused, never truncated or padded', () => {
      expect(
        sanitizeRunnerListEntry({ ...validEntry, public_key: PUBLIC_KEY_A.slice(0, 43) }),
      ).toBeNull()
      expect(sanitizeRunnerListEntry({ ...validEntry, public_key: `${PUBLIC_KEY_A}A` })).toBeNull()
    })

    test('the URL-safe base64 alphabet (- or _) is refused: standard base64 only', () => {
      const urlSafe = `${PUBLIC_KEY_A.slice(0, 10)}-${PUBLIC_KEY_A.slice(11)}`
      expect(sanitizeRunnerListEntry({ ...validEntry, public_key: urlSafe })).toBeNull()
    })

    test('a missing padding character is refused, never re-padded', () => {
      const unpadded = PUBLIC_KEY_A.slice(0, 43)
      expect(sanitizeRunnerListEntry({ ...validEntry, public_key: unpadded })).toBeNull()
    })

    test('a valid public_key is kept byte for byte', () => {
      expect(sanitizeRunnerListEntry({ ...validEntry, public_key: PUBLIC_KEY_B })?.public_key).toBe(
        PUBLIC_KEY_B,
      )
    })
  })

  test('name is truncated, never rejected for length', () => {
    const r = sanitizeRunnerListEntry({ ...validEntry, name: 'n'.repeat(RUNNER_NAME_MAX + 50) })
    expect(r?.name.length).toBe(RUNNER_NAME_MAX)
  })

  test('a blank or non-string name falls back to a fixed placeholder, never the empty string', () => {
    for (const name of [undefined, null, '', '   ', 42, {}, []]) {
      const r = sanitizeRunnerListEntry({ ...validEntry, name })
      expect(r?.name).toBe('unnamed runner')
    }
  })

  test('truncation never leaves a trailing space on name, even when the cut lands on an internal run of whitespace', () => {
    const nameWithInternalSpace = `${'n'.repeat(RUNNER_NAME_MAX - 1)} ${'x'.repeat(50)}`
    const r = sanitizeRunnerListEntry({ ...validEntry, name: nameWithInternalSpace })
    expect(r?.name).toBe(r?.name.trim())
  })

  test('last_seen_at: absent, blank or non-string becomes null', () => {
    for (const last_seen_at of [undefined, null, '', '   ', 42, {}, []]) {
      expect(sanitizeRunnerListEntry({ ...validEntry, last_seen_at })?.last_seen_at).toBeNull()
    }
  })

  test('last_seen_at is truncated, never rejected for length', () => {
    const long = '2'.repeat(RUNNER_TIMESTAMP_MAX + 50)
    const r = sanitizeRunnerListEntry({ ...validEntry, last_seen_at: long })
    expect(r?.last_seen_at?.length).toBe(RUNNER_TIMESTAMP_MAX)
  })

  test('has_pending_secret is read strictly: only the literal boolean true counts', () => {
    expect(
      sanitizeRunnerListEntry({ ...validEntry, has_pending_secret: true })?.has_pending_secret,
    ).toBe(true)
    for (const has_pending_secret of [false, undefined, null, 1, 'true', {}, []]) {
      expect(
        sanitizeRunnerListEntry({ ...validEntry, has_pending_secret })?.has_pending_secret,
      ).toBe(false)
    }
  })

  test('hostile input, once sanitized, still validates against the published schema', () => {
    const hostile = sanitizeRunnerListEntry({
      fingerprint: FINGERPRINT_A,
      public_key: PUBLIC_KEY_A,
      name: 42,
      last_seen_at: [],
      has_pending_secret: 'yes',
    })
    expect(hostile).not.toBeNull()
    expect(listEntrySchemaErrors(hostile)).toEqual([])
  })
})

// --- sanitizeSealedSecretBlob ---------------------------------------------------

describe('sanitizeSealedSecretBlob', () => {
  test('a valid blob round-trips unchanged', () => {
    expect(sanitizeSealedSecretBlob(structuredClone(validBlob))).toEqual(validBlob)
  })

  test('non-object input: null', () => {
    expect(sanitizeSealedSecretBlob(null)).toBeNull()
    expect(sanitizeSealedSecretBlob(undefined)).toBeNull()
    expect(sanitizeSealedSecretBlob('junk')).toBeNull()
    expect(sanitizeSealedSecretBlob(42)).toBeNull()
    expect(sanitizeSealedSecretBlob([])).toBeNull()
  })

  describe('ciphertext gates the whole record', () => {
    test('a non-string ciphertext drops the WHOLE blob', () => {
      for (const ciphertext of [undefined, null, 42, {}, []]) {
        expect(sanitizeSealedSecretBlob({ ...validBlob, ciphertext })).toBeNull()
      }
    })

    test('an empty ciphertext drops the WHOLE blob', () => {
      expect(sanitizeSealedSecretBlob({ ...validBlob, ciphertext: '' })).toBeNull()
    })

    test('a ciphertext exactly at SEALED_BLOB_MAX_B64 is kept unchanged', () => {
      const atMax = 'a'.repeat(SEALED_BLOB_MAX_B64)
      expect(sanitizeSealedSecretBlob({ ...validBlob, ciphertext: atMax })?.ciphertext).toBe(atMax)
    })

    test('a ciphertext one character over SEALED_BLOB_MAX_B64 drops the WHOLE blob, never truncated', () => {
      const overMax = 'a'.repeat(SEALED_BLOB_MAX_B64 + 1)
      expect(sanitizeSealedSecretBlob({ ...validBlob, ciphertext: overMax })).toBeNull()
    })
  })

  test('missing pushed_at falls back to a generated stamp', () => {
    const r = sanitizeSealedSecretBlob({ ...validBlob, pushed_at: undefined })
    expect(typeof r?.pushed_at).toBe('string')
    expect(r?.pushed_at.length).toBeGreaterThan(0)
  })

  test('a blank pushed_at falls back to a generated stamp', () => {
    const r = sanitizeSealedSecretBlob({ ...validBlob, pushed_at: '   ' })
    expect(typeof r?.pushed_at).toBe('string')
    expect(r?.pushed_at.length).toBeGreaterThan(0)
  })

  test('pushed_at is truncated, never rejected for length', () => {
    const long = '2'.repeat(RUNNER_TIMESTAMP_MAX + 50)
    const r = sanitizeSealedSecretBlob({ ...validBlob, pushed_at: long })
    expect(r?.pushed_at.length).toBe(RUNNER_TIMESTAMP_MAX)
  })
})

// --- The published schemas ----------------------------------------------------

describe('runnerListEntrySchema / sealedSecretBlobSchema', () => {
  test('both declare a draft 2020-12 schema with their own id', () => {
    expect(runnerListEntrySchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(runnerListEntrySchema.$id).toBe('https://codesema.com/schemas/runner-list-entry.json')
    expect(sealedSecretBlobSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(sealedSecretBlobSchema.$id).toBe('https://codesema.com/schemas/sealed-secret-blob.json')
  })

  test('every required key exists in properties, on both schemas', () => {
    for (const schema of [runnerListEntrySchema, sealedSecretBlobSchema]) {
      const props = new Set(Object.keys(schema.properties))
      for (const key of schema.required) {
        expect(props.has(key)).toBe(true)
      }
    }
  })
})

// --- Cross tests: sanitizer output validates against the published schema, and
// the schema is not looser than what the sanitizer actually accepts. Deliberately
// local and tiny, like arm.test.ts's own validator: this proves the SCHEMA
// against the SANITIZER, not a library's leniency. Neither published schema here
// uses $ref/$defs or arrays, so unlike arm.test.ts's own copy of this validator,
// there is no deref step and no array/number branch to carry.

type Schema = Record<string, unknown>

function typeMatches(node: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return node === null
    case 'string':
      return typeof node === 'string'
    case 'boolean':
      return typeof node === 'boolean'
    case 'object':
      return !!node && typeof node === 'object' && !Array.isArray(node)
    default:
      return false
  }
}

function validateString(node: string, s: Schema, path: string): string[] {
  const errors: string[] = []
  const length = [...node].length
  if (typeof s.maxLength === 'number' && length > s.maxLength) {
    errors.push(`${path}: maxLength`)
  }
  if (typeof s.minLength === 'number' && length < s.minLength) {
    errors.push(`${path}: minLength`)
  }
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(node)) {
    errors.push(`${path}: pattern`)
  }
  return errors
}

function validateObject(node: object, s: Schema, path: string): string[] {
  const errors: string[] = []
  const record = node as Record<string, unknown>
  const properties = (s.properties ?? {}) as Record<string, Schema>
  for (const key of (s.required ?? []) as string[]) {
    if (!Object.hasOwn(record, key)) {
      errors.push(`${path}.${key}: required`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (!child) {
      if (s.additionalProperties === false) {
        errors.push(`${path}.${key}: additionalProperties`)
      }
      continue
    }
    errors.push(...validate(value, child, `${path}.${key}`))
  }
  return errors
}

function validate(node: unknown, schema: Schema, path = '$'): string[] {
  const types =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? (schema.type as string[])
        : []
  const hasAssertion =
    'const' in schema || 'enum' in schema || types.length > 0 || Array.isArray(schema.anyOf)
  if (!hasAssertion) {
    // A schema node that asserts NOTHING accepts every value that reaches it.
    // Fail loudly here instead of quietly proving nothing.
    throw new Error(`runner schema validator: '${path}' asserts nothing`)
  }
  const errors: string[] = []
  if ('const' in schema && node !== schema.const) {
    errors.push(`${path}: const`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(node)) {
    errors.push(`${path}: enum`)
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Schema[]
    if (!branches.some((branch) => validate(node, branch, path).length === 0)) {
      errors.push(`${path}: anyOf`)
    }
  }
  if (types.length === 0) {
    return errors
  }
  if (!types.some((type) => typeMatches(node, type))) {
    errors.push(`${path}: type`)
    return errors
  }
  if (typeof node === 'string') {
    errors.push(...validateString(node, schema, path))
  } else if (node && typeof node === 'object') {
    errors.push(...validateObject(node, schema, path))
  }
  return errors
}

const listEntrySchemaErrors = (value: unknown): string[] =>
  validate(value, runnerListEntrySchema as unknown as Schema)

const blobSchemaErrors = (value: unknown): string[] =>
  validate(value, sealedSecretBlobSchema as unknown as Schema)

describe('cross test: sanitizeRunnerListEntry output validates against runnerListEntrySchema', () => {
  test('the full nominal entry validates', () => {
    expect(listEntrySchemaErrors(sanitizeRunnerListEntry(structuredClone(validEntry)))).toEqual([])
  })

  test('an entry with last_seen_at null validates', () => {
    const withNull = { ...validEntry, last_seen_at: null }
    expect(listEntrySchemaErrors(sanitizeRunnerListEntry(withNull))).toEqual([])
  })

  test('an entry with a fallback name validates', () => {
    expect(listEntrySchemaErrors(sanitizeRunnerListEntry({ ...validEntry, name: '' }))).toEqual([])
  })
})

describe('reverse cross test: runnerListEntrySchema is not looser than sanitizeRunnerListEntry accepts', () => {
  const BASE = {
    name: 'runner',
    fingerprint: FINGERPRINT_A,
    public_key: PUBLIC_KEY_A,
    last_seen_at: null,
    has_pending_secret: false,
  }

  test('an empty fingerprint is schema-invalid: sanitizeRunnerListEntry refuses the WHOLE record for it', () => {
    expect(listEntrySchemaErrors({ ...BASE, fingerprint: '' })).not.toEqual([])
  })

  test('an uppercase fingerprint is schema-invalid: sanitizeRunnerListEntry never case-folds one', () => {
    expect(
      listEntrySchemaErrors({ ...BASE, fingerprint: FINGERPRINT_A.toUpperCase() }),
    ).not.toEqual([])
  })

  test('an empty name is schema-invalid: sanitizeRunnerListEntry only ever emits a non-blank name', () => {
    expect(listEntrySchemaErrors({ ...BASE, name: '' })).not.toEqual([])
  })

  test('a missing key is schema-invalid: every key of RunnerListEntry is always present', () => {
    const { has_pending_secret: _drop, ...missing } = BASE
    expect(listEntrySchemaErrors(missing)).not.toEqual([])
  })

  test('an extra unknown key is schema-invalid: additionalProperties is false', () => {
    expect(listEntrySchemaErrors({ ...BASE, extra: 'nope' })).not.toEqual([])
  })
})

describe('cross test: sanitizeSealedSecretBlob output validates against sealedSecretBlobSchema', () => {
  test('the nominal blob validates', () => {
    expect(blobSchemaErrors(sanitizeSealedSecretBlob(structuredClone(validBlob)))).toEqual([])
  })

  test('a blob with ciphertext at the exact bound validates', () => {
    const atMax = sanitizeSealedSecretBlob({
      ...validBlob,
      ciphertext: 'a'.repeat(SEALED_BLOB_MAX_B64),
    })
    expect(blobSchemaErrors(atMax)).toEqual([])
  })
})

describe('reverse cross test: sealedSecretBlobSchema is not looser than sanitizeSealedSecretBlob accepts', () => {
  const BASE = {
    ciphertext: 'c2VhbGVk',
    pushed_at: '2026-08-14T10:00:00.000Z',
  }

  test('an empty ciphertext is schema-invalid: sanitizeSealedSecretBlob refuses the WHOLE record for it', () => {
    expect(blobSchemaErrors({ ...BASE, ciphertext: '' })).not.toEqual([])
  })

  test('an oversized ciphertext is schema-invalid: sanitizeSealedSecretBlob never truncates it', () => {
    expect(
      blobSchemaErrors({ ...BASE, ciphertext: 'a'.repeat(SEALED_BLOB_MAX_B64 + 1) }),
    ).not.toEqual([])
  })

  test('a missing key is schema-invalid: every key of SealedSecretBlob is always present', () => {
    const { pushed_at: _drop, ...missing } = BASE
    expect(blobSchemaErrors(missing)).not.toEqual([])
  })

  test('an extra unknown key is schema-invalid: additionalProperties is false', () => {
    expect(blobSchemaErrors({ ...BASE, extra: 'nope' })).not.toEqual([])
  })
})

describe('cross-repo: runner request bodies match the hub schemas byte for byte on their bounds', () => {
  const ajv = new Ajv({ allErrors: true })
  const validRegister = ajv.compile(runnerRegisterBodySchema)
  const validSecret = ajv.compile(runnerSecretBodySchema)

  test("a register body at this package's exact bounds passes the hub schema", () => {
    const body = {
      public_key: 'A'.repeat(RUNNER_PUBLIC_KEY_B64_LEN - 1) + '=',
      name: 'n'.repeat(RUNNER_NAME_MAX),
    }
    expect(validRegister(body)).toBe(true)
  })

  test('the hub schema pins public_key to the same exact length as this package', () => {
    expect(
      validRegister({ public_key: 'A'.repeat(RUNNER_PUBLIC_KEY_B64_LEN + 1), name: 'x' }),
    ).toBe(false)
    expect(
      validRegister({ public_key: 'A'.repeat(RUNNER_PUBLIC_KEY_B64_LEN - 1), name: 'x' }),
    ).toBe(false)
  })

  test("a sealed blob at this package's ceiling passes, one byte over fails", () => {
    expect(validSecret({ ciphertext: 'c'.repeat(SEALED_BLOB_MAX_B64) })).toBe(true)
    expect(validSecret({ ciphertext: 'c'.repeat(SEALED_BLOB_MAX_B64 + 1) })).toBe(false)
    expect(validSecret({ ciphertext: '' })).toBe(false)
  })
})
