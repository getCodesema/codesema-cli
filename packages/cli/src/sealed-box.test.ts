import { describe, expect, test } from 'bun:test'
import {
  formatFingerprint,
  generateRunnerKeyPair,
  runnerKeyFingerprint,
  seal,
  unseal,
} from './sealed-box.js'

describe('generateRunnerKeyPair', () => {
  test('produces 32-byte raw public and private keys', () => {
    const pair = generateRunnerKeyPair()
    expect(pair.publicKey.length).toBe(32)
    expect(pair.privateKey.length).toBe(32)
  })

  test('two calls produce different keys', () => {
    const a = generateRunnerKeyPair()
    const b = generateRunnerKeyPair()
    expect(a.publicKey.equals(b.publicKey)).toBe(false)
    expect(a.privateKey.equals(b.privateKey)).toBe(false)
  })
})

describe('runnerKeyFingerprint', () => {
  test('is a 64-character lowercase hex string', () => {
    const { publicKey } = generateRunnerKeyPair()
    expect(runnerKeyFingerprint(publicKey)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is stable for the same key', () => {
    const { publicKey } = generateRunnerKeyPair()
    expect(runnerKeyFingerprint(publicKey)).toBe(runnerKeyFingerprint(publicKey))
  })

  test('differs across keys', () => {
    const a = generateRunnerKeyPair()
    const b = generateRunnerKeyPair()
    expect(runnerKeyFingerprint(a.publicKey)).not.toBe(runnerKeyFingerprint(b.publicKey))
  })
})

describe('formatFingerprint', () => {
  test('splits the full 64 hex characters into groups of 4 separated by spaces', () => {
    const fingerprint = 'a'.repeat(64)
    const formatted = formatFingerprint(fingerprint)
    expect(formatted).toBe(Array(16).fill('aaaa').join(' '))
  })

  test('never truncates: every original character survives', () => {
    const { publicKey } = generateRunnerKeyPair()
    const fingerprint = runnerKeyFingerprint(publicKey)
    const formatted = formatFingerprint(fingerprint)
    expect(formatted.replace(/ /g, '')).toBe(fingerprint)
  })
})

describe('seal / unseal round trip', () => {
  test('the recipient recovers the exact plaintext', () => {
    const recipient = generateRunnerKeyPair()
    const plaintext = Buffer.from('a runner secret token')
    const blob = seal(recipient.publicKey, plaintext)
    expect(unseal(recipient.privateKey, blob)?.equals(plaintext)).toBe(true)
  })

  test('round trips an empty plaintext', () => {
    const recipient = generateRunnerKeyPair()
    const blob = seal(recipient.publicKey, Buffer.alloc(0))
    expect(unseal(recipient.privateKey, blob)?.equals(Buffer.alloc(0))).toBe(true)
  })

  test('two seals of the same plaintext produce different blobs (fresh ephemeral key and nonce)', () => {
    const recipient = generateRunnerKeyPair()
    const plaintext = Buffer.from('same secret')
    expect(seal(recipient.publicKey, plaintext)).not.toBe(seal(recipient.publicKey, plaintext))
  })
})

describe('unseal never throws and rejects tampering', () => {
  test('a single flipped byte in the ciphertext fails authentication', () => {
    const recipient = generateRunnerKeyPair()
    const blob = seal(recipient.publicKey, Buffer.from('secret'))
    const envelope = JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as { ct: string }
    const ct = Buffer.from(envelope.ct, 'base64')
    ct.writeUInt8(ct.readUInt8(0) ^ 0xff, 0)
    envelope.ct = ct.toString('base64')
    const tampered = Buffer.from(JSON.stringify(envelope)).toString('base64')
    expect(unseal(recipient.privateKey, tampered)).toBeNull()
  })

  test('the wrong recipient cannot decrypt', () => {
    const recipient = generateRunnerKeyPair()
    const attacker = generateRunnerKeyPair()
    const blob = seal(recipient.publicKey, Buffer.from('secret'))
    expect(unseal(attacker.privateKey, blob)).toBeNull()
  })

  test('a blob that is not valid base64/JSON returns null', () => {
    const recipient = generateRunnerKeyPair()
    expect(unseal(recipient.privateKey, '!!! not a sealed box !!!')).toBeNull()
  })

  test('an empty string returns null', () => {
    const recipient = generateRunnerKeyPair()
    expect(unseal(recipient.privateKey, '')).toBeNull()
  })

  test('valid base64 that decodes to non-JSON returns null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from('this is not json').toString('base64')
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })

  test('a JSON scalar (not an object) returns null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from(JSON.stringify('just a string')).toString('base64')
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })

  test('an unknown envelope version returns null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from(JSON.stringify({ v: 2, epk: 'x', nonce: 'y', ct: 'z' })).toString(
      'base64',
    )
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })

  test('missing fields return null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from(JSON.stringify({ v: 1 })).toString('base64')
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })

  test('a wrong-length ephemeral public key returns null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from(
      JSON.stringify({
        v: 1,
        epk: Buffer.alloc(31).toString('base64'),
        nonce: Buffer.alloc(12).toString('base64'),
        ct: Buffer.alloc(32).toString('base64'),
      }),
    ).toString('base64')
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })

  test('a wrong-length nonce returns null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from(
      JSON.stringify({
        v: 1,
        epk: Buffer.alloc(32).toString('base64'),
        nonce: Buffer.alloc(11).toString('base64'),
        ct: Buffer.alloc(32).toString('base64'),
      }),
    ).toString('base64')
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })

  test('a ciphertext shorter than the GCM tag returns null', () => {
    const recipient = generateRunnerKeyPair()
    const blob = Buffer.from(
      JSON.stringify({
        v: 1,
        epk: Buffer.alloc(32).toString('base64'),
        nonce: Buffer.alloc(12).toString('base64'),
        ct: Buffer.alloc(4).toString('base64'),
      }),
    ).toString('base64')
    expect(unseal(recipient.privateKey, blob)).toBeNull()
  })
})

describe('frozen construction vector', () => {
  // Locks the wire construction down: HKDF salt/info, AAD, envelope field
  // names and order, and base64 framing. If this ever changes, EVERY caller
  // that persisted or transmitted a blob under the old construction breaks,
  // so a change here must be deliberate, not an accidental refactor.
  const recipientPublicKey = Buffer.from('XVK0wPwH+z7M0nmqdWSI5Fc2gkws/dFnIFASExxfxHE=', 'base64')
  const recipientPrivateKey = Buffer.from('hzGWKy+inBI5YzNkT51oOMZfpwnGAaIRMwUufaWDTJg=', 'base64')
  const ephemeralPublicKey = Buffer.from('ItAWoLmSkyrcRLnCXzP0nXO90p1/aMdl0H8Lt3CNHQ4=', 'base64')
  const ephemeralPrivateKey = Buffer.from('d16HoXVw8fUm3SxjlzuMHpB/4svzGlCl6iNCaTIExr8=', 'base64')
  const nonce = Buffer.alloc(12, 0x05)
  const plaintext = Buffer.from('frozen-vector-plaintext')
  const expectedBlob =
    'eyJ2IjoxLCJlcGsiOiJJdEFXb0xtU2t5cmNSTG5DWHpQMG5YTzkwcDEvYU1kbDBIOEx0M0NOSFE0PSIsIm5vbmNlIjoiQlFVRkJRVUZCUVVGQlFVRiIsImN0IjoiL0IvNDc4QUhaZGZmV2k5eVg0ZlF1MkZPWUl3bUI3RndyOFVWWC90U1U4VDJ1SHRFYmdzcyJ9'

  test('sealing with fixed seams reproduces the exact recorded blob', () => {
    const blob = seal(recipientPublicKey, plaintext, {
      ephemeral: { publicKey: ephemeralPublicKey, privateKey: ephemeralPrivateKey },
      nonce,
    })
    expect(blob).toBe(expectedBlob)
  })

  test('the recorded blob still unseals to the original plaintext', () => {
    expect(unseal(recipientPrivateKey, expectedBlob)?.equals(plaintext)).toBe(true)
  })
})
