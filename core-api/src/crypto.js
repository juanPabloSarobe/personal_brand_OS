import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

function masterKey() {
  const hex = process.env.MASTER_KEY || ''
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MASTER_KEY debe ser 32 bytes en hex (64 caracteres)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptJson(obj) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join('.')
}

export function decryptJson(blob) {
  const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'))
}
