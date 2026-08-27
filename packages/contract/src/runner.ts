// Hub wire contract: types and sanitizers for the runners a codesema arm
// registers with the hub (an X25519 keypair identity, fingerprinted as a
// sha256 hex digest) and for the mailbox of secrets the hub seals to a
// runner's public key. Same doctrine as arm.ts: whitelist and truncate free
// text, never throw. `fingerprint` and `public_key` are cryptographic
// identity, not free text, so unlike every truncated field elsewhere in
// this package they are refused whole rather than cut or case-folded when
// they do not match their expected shape exactly.

import { NON_BLANK } from './ticket.js'

/**
 * A runner the hub knows about, as returned by its runner-list endpoint.
 * `fingerprint` (the sha256 hex digest of `public_key`) is this type's
 * identity: unlike `name`, it is never truncated or fabricated, only
 * matched exactly or refused (see `sanitizeRunnerListEntry`).
 */
export type RunnerListEntry = {
  name: string
  fingerprint: string
  public_key: string
  last_seen_at: string | null
  has_pending_secret: boolean
}

/**
 * A secret blob the hub has sealed (encrypted) to one runner's public key,
 * waiting to be picked up. `ciphertext` is opaque base64 to this package: it
 * is validated for shape (non-empty, bounded) but never decoded or read.
 */
export type SealedSecretBlob = {
  ciphertext: string
  pushed_at: string
}

export const RUNNER_NAME_MAX = 200
/** A sha256 hex digest of a runner's public key: exactly this many lowercase hex characters. */
export const RUNNER_FINGERPRINT_LEN = 64
/** Standard base64 of exactly 32 raw bytes (an X25519 public key): always this many characters. */
export const RUNNER_PUBLIC_KEY_B64_LEN = 44
export const SEALED_BLOB_MAX_B64 = 8192
/** Bound for an ISO-8601 instant read back from the wire: same figure as arm.ts's own ARM_TIMESTAMP_MAX. */
export const RUNNER_TIMESTAMP_MAX = 40

/**
 * `name`'s fallback when the hub sends a blank one: a fixed placeholder,
 * never a value borrowed from elsewhere on the same record. Reusing
 * `fingerprint` as a display name here would still be correct today, but it
 * would tie a field that degrades independently to one that gates the whole
 * record, the two are kept unrelated on purpose.
 */
const RUNNER_NAME_FALLBACK = 'unnamed runner'

/** Whitelisted, not merely bounded: hex lowercase, exactly RUNNER_FINGERPRINT_LEN characters. */
const RUNNER_FINGERPRINT_PATTERN = `^[0-9a-f]{${RUNNER_FINGERPRINT_LEN}}$`
const RUNNER_FINGERPRINT_RE = new RegExp(RUNNER_FINGERPRINT_PATTERN)

/**
 * Standard base64 of exactly 32 raw bytes: 32 does not fall on a 3-byte
 * boundary, so the final 4-character group carries one literal `=` pad,
 * leaving RUNNER_PUBLIC_KEY_B64_LEN - 1 real alphabet characters ahead of it.
 */
const RUNNER_PUBLIC_KEY_PATTERN = `^[A-Za-z0-9+/]{${RUNNER_PUBLIC_KEY_B64_LEN - 1}}=$`
const RUNNER_PUBLIC_KEY_RE = new RegExp(RUNNER_PUBLIC_KEY_PATTERN)

/**
 * Trim, cut, trim again: same recipe as arm.ts's own `str`, duplicated
 * rather than imported (that helper is private to arm.ts). Load-bearing for
 * the same reason there: a value sliced at `max` can still gain a trailing
 * space from an internal run of whitespace landing right at the cut.
 */
const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max).trim() : ''

const nullableStr = (v: unknown, max: number): string | null => {
  const s = str(v, max)
  return s ? s : null
}

/** `pushed_at`'s doctrine: an ISO instant, bounded, falling back to now when unusable, same idiom as arm.ts's own `isoOrNow`. */
const isoOrNow = (v: unknown, max: number = RUNNER_TIMESTAMP_MAX): string => {
  const s = str(v, max)
  return s ? s : new Date().toISOString()
}

/**
 * A runner's fingerprint is cryptographic identity, not free text: refused
 * whole on any mismatch (wrong length, wrong case, wrong alphabet) rather
 * than truncated or normalized, same never-fabricate rule `sanitizeArmTicket`
 * applies to `status` (arm.ts). Half a fingerprint, or one folded to
 * lowercase behind the caller's back, is not safe to treat as an identity.
 */
function sanitizeRunnerFingerprint(raw: unknown): string | null {
  return typeof raw === 'string' && RUNNER_FINGERPRINT_RE.test(raw) ? raw : null
}

/** Same never-fabricate rule as `sanitizeRunnerFingerprint`, applied to the public key half of the pair. */
function sanitizeRunnerPublicKey(raw: unknown): string | null {
  return typeof raw === 'string' && RUNNER_PUBLIC_KEY_RE.test(raw) ? raw : null
}

/**
 * Ciphertext is opaque bytes, not free text: an oversized or empty blob is
 * refused whole rather than truncated. Truncating ciphertext does not
 * produce a smaller valid secret, it produces garbage that merely looks
 * intact, same reasoning as `sanitizeArmSha` (arm.ts) refusing a partial
 * hash rather than keeping it.
 */
function sanitizeCiphertext(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= SEALED_BLOB_MAX_B64 ? raw : null
}

/**
 * Revalidates a runner entry read off the hub's list. Two fields gate the
 * whole record, `fingerprint` and `public_key`: together they are this
 * type's identity, and neither is safe to half-trust (see
 * `sanitizeRunnerFingerprint` and `sanitizeRunnerPublicKey`). `name`
 * degrades independently: a blank one falls back to a fixed placeholder
 * rather than the empty string, same str-then-fallback idiom as arm.ts's
 * own `isoOr`. `has_pending_secret` is read strictly: only the literal
 * boolean `true` counts, any other value (including a truthy non-boolean)
 * degrades to `false`.
 */
export function sanitizeRunnerListEntry(raw: unknown): RunnerListEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const fingerprint = sanitizeRunnerFingerprint(r.fingerprint)
  const public_key = sanitizeRunnerPublicKey(r.public_key)
  if (!fingerprint || !public_key) {
    return null
  }
  return {
    name: str(r.name, RUNNER_NAME_MAX) || RUNNER_NAME_FALLBACK,
    fingerprint,
    public_key,
    last_seen_at: nullableStr(r.last_seen_at, RUNNER_TIMESTAMP_MAX),
    has_pending_secret: r.has_pending_secret === true,
  }
}

/**
 * Revalidates a sealed secret blob read off the hub's mailbox. Gated on
 * `ciphertext` (see `sanitizeCiphertext`): a blob whose payload is unusable
 * is not a degraded blob, it is not a blob. `pushed_at` follows arm.ts's
 * `isoOrNow` doctrine instead, an unusable stamp falls back to now rather
 * than sinking the whole record, the same treatment `ArmTransition.at` gets.
 */
export function sanitizeSealedSecretBlob(raw: unknown): SealedSecretBlob | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const ciphertext = sanitizeCiphertext(r.ciphertext)
  if (!ciphertext) {
    return null
  }
  return {
    ciphertext,
    pushed_at: isoOrNow(r.pushed_at),
  }
}

/**
 * JSON Schema (draft 2020-12) for a `RunnerListEntry`, same pattern as
 * `armTicketSchema` (arm.ts): every `sanitizeRunnerListEntry` output
 * validates here (forward), and the schema refuses every shape the
 * sanitizer refuses (backward, tested in runner.test.ts), so the two cannot
 * silently drift apart.
 */
export const runnerListEntrySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/runner-list-entry.json',
  title: 'Codesema runner list entry',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'fingerprint', 'public_key', 'last_seen_at', 'has_pending_secret'],
  properties: {
    name: { type: 'string', maxLength: RUNNER_NAME_MAX, pattern: NON_BLANK },
    fingerprint: { type: 'string', pattern: RUNNER_FINGERPRINT_PATTERN },
    public_key: { type: 'string', pattern: RUNNER_PUBLIC_KEY_PATTERN },
    last_seen_at: {
      anyOf: [
        { type: 'null' },
        { type: 'string', maxLength: RUNNER_TIMESTAMP_MAX, pattern: NON_BLANK },
      ],
    },
    has_pending_secret: { type: 'boolean' },
  },
} as const

/**
 * JSON Schema (draft 2020-12) for a `SealedSecretBlob`, same pattern and
 * same forward/backward guarantee as `runnerListEntrySchema` above.
 */
export const sealedSecretBlobSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/sealed-secret-blob.json',
  title: 'Codesema sealed secret blob',
  type: 'object',
  additionalProperties: false,
  required: ['ciphertext', 'pushed_at'],
  properties: {
    ciphertext: { type: 'string', minLength: 1, maxLength: SEALED_BLOB_MAX_B64 },
    pushed_at: { type: 'string', maxLength: RUNNER_TIMESTAMP_MAX, pattern: NON_BLANK },
  },
} as const
