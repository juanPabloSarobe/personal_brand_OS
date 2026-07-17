import { describe, it, expect, beforeEach } from 'vitest'
import { encryptJson, decryptJson } from '../src/crypto.js'

describe('crypto', () => {
  beforeEach(() => {
    process.env.MASTER_KEY = 'ab'.repeat(32) // 64 chars hex
  })

  it('cifra y descifra un objeto (round-trip)', () => {
    const secret = { access_token: 'tok-123', refresh_token: 'ref-456' }
    const blob = encryptJson(secret)
    expect(blob).not.toContain('tok-123')
    expect(decryptJson(blob)).toEqual(secret)
  })

  it('dos cifrados del mismo objeto difieren (IV aleatorio)', () => {
    const secret = { a: 1 }
    expect(encryptJson(secret)).not.toBe(encryptJson(secret))
  })

  it('rechaza MASTER_KEY inválida', () => {
    process.env.MASTER_KEY = 'corta'
    expect(() => encryptJson({ a: 1 })).toThrow(/MASTER_KEY/)
  })

  it('detecta manipulación del blob', () => {
    const blob = encryptJson({ a: 1 })
    const roto = blob.slice(0, -4) + 'AAAA'
    expect(() => decryptJson(roto)).toThrow()
  })
})
