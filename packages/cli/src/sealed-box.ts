import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

export type RunnerKeyPair = {
  publicKey: Buffer
  privateKey: Buffer
}

export type SealSeams = {
  ephemeral?: RunnerKeyPair
  nonce?: Buffer
}

const ENVELOPE_VERSION = 1
const RAW_KEY_LENGTH = 32
const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const HKDF_SALT = Buffer.from('codesema-sealed-box-v1')

// X25519 has no ASN.1 parameters and a fixed-width OID, so its SPKI/PKCS8 DER
// encodings are a constant-length prefix followed by the raw 32-byte key.
// Bun's node:crypto (checked on 1.3.13) has no 'raw' export/import format for
// OKP keys, so this prefix-and-slice is how raw bytes cross the KeyObject
// boundary in both directions.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

function rawPublicKeyToKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

function rawPrivateKeyToKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}

function keyObjectToRawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'der', type: 'spki' })).subarray(
    X25519_SPKI_PREFIX.length,
  )
}

function keyObjectToRawPrivateKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'der', type: 'pkcs8' })).subarray(
    X25519_PKCS8_PREFIX.length,
  )
}

export function generateRunnerKeyPair(): RunnerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: keyObjectToRawPublicKey(publicKey),
    privateKey: keyObjectToRawPrivateKey(privateKey),
  }
}

export function runnerKeyFingerprint(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex')
}

export function formatFingerprint(fingerprint: string): string {
  const groups: string[] = []
  for (let i = 0; i < fingerprint.length; i += 4) {
    groups.push(fingerprint.slice(i, i + 4))
  }
  return groups.join(' ')
}

function deriveSharedKey(
  sharedSecret: Buffer,
  ephemeralPublicKey: Buffer,
  recipientPublicKey: Buffer,
): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      sharedSecret,
      HKDF_SALT,
      Buffer.concat([ephemeralPublicKey, recipientPublicKey]),
      32,
    ),
  )
}

export function seal(recipientPublicKey: Buffer, plaintext: Buffer, seams?: SealSeams): string {
  const ephemeral = seams?.ephemeral ?? generateRunnerKeyPair()
  const nonce = seams?.nonce ?? randomBytes(NONCE_LENGTH)

  const sharedSecret = diffieHellman({
    privateKey: rawPrivateKeyToKeyObject(ephemeral.privateKey),
    publicKey: rawPublicKeyToKeyObject(recipientPublicKey),
  })
  const key = deriveSharedKey(sharedSecret, ephemeral.publicKey, recipientPublicKey)

  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_LENGTH })
  // AAD binds the ciphertext to its addressee: a blob sealed for one runner's
  // public key fails authentication if replayed against a different one.
  cipher.setAAD(recipientPublicKey)
  const sealedCiphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  const envelope = {
    v: ENVELOPE_VERSION,
    epk: ephemeral.publicKey.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: sealedCiphertext.toString('base64'),
  }
  return Buffer.from(JSON.stringify(envelope)).toString('base64')
}

export function unseal(recipientPrivateKey: Buffer, blob: string): Buffer | null {
  try {
    const envelope = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as unknown
    if (typeof envelope !== 'object' || envelope === null) {
      return null
    }
    const fields = envelope as Record<string, unknown>
    if (fields.v !== ENVELOPE_VERSION) {
      return null
    }
    if (
      typeof fields.epk !== 'string' ||
      typeof fields.nonce !== 'string' ||
      typeof fields.ct !== 'string'
    ) {
      return null
    }

    const ephemeralPublicKey = Buffer.from(fields.epk, 'base64')
    const nonce = Buffer.from(fields.nonce, 'base64')
    const sealedCiphertext = Buffer.from(fields.ct, 'base64')
    if (
      ephemeralPublicKey.length !== RAW_KEY_LENGTH ||
      nonce.length !== NONCE_LENGTH ||
      sealedCiphertext.length < AUTH_TAG_LENGTH
    ) {
      return null
    }

    const privateKeyObject = rawPrivateKeyToKeyObject(recipientPrivateKey)
    // createPublicKey's types don't model its documented KeyObject overload
    // (deriving the public key from a private one); real at runtime, just
    // untyped in this @types/node version.
    const derivedPublicKeyObject = createPublicKey(
      privateKeyObject as unknown as Parameters<typeof createPublicKey>[0],
    )
    const recipientPublicKey = keyObjectToRawPublicKey(derivedPublicKeyObject)
    const sharedSecret = diffieHellman({
      privateKey: privateKeyObject,
      publicKey: rawPublicKeyToKeyObject(ephemeralPublicKey),
    })
    const key = deriveSharedKey(sharedSecret, ephemeralPublicKey, recipientPublicKey)

    const ciphertext = sealedCiphertext.subarray(0, sealedCiphertext.length - AUTH_TAG_LENGTH)
    const authTag = sealedCiphertext.subarray(sealedCiphertext.length - AUTH_TAG_LENGTH)

    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_LENGTH })
    decipher.setAAD(recipientPublicKey)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return null
  }
}
