import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sendMessage, sendPhotoFile } from '../src/services/telegram.js'
import { readFileSync } from 'fs'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('telegram notifier', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok-test'
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  it('sendMessage construye URL correcta y envía el mensaje', async () => {
    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const result = await sendMessage('12345', 'Hola desde el core', { fetchImpl })

    expect(result.ok).toBe(true)
    expect(captured.url).toBe('https://api.telegram.org/bottok-test/sendMessage')
    expect(captured.opts.method).toBe('POST')
    expect(captured.opts.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(captured.opts.body)
    expect(body.chat_id).toBe('12345')
    expect(body.text).toBe('Hola desde el core')
  })

  it('sendPhotoFile usa FormData multipart con caption truncada a 1024', async () => {
    // Crear archivo temporal
    const testFile = join(tmpdir(), 'test-photo-' + Date.now() + '.jpg')
    writeFileSync(testFile, Buffer.from('fake-jpeg-data'))

    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const longCaption = 'A'.repeat(2000)
    const result = await sendPhotoFile('12345', testFile, longCaption, { fetchImpl })

    expect(result.ok).toBe(true)
    expect(captured.url).toBe('https://api.telegram.org/bottok-test/sendPhoto')
    expect(captured.opts.method).toBe('POST')
    expect(captured.opts.body).toBeInstanceOf(FormData)

    // Verificar que FormData contiene los campos correctos
    const formEntries = Array.from(captured.opts.body.entries())
    expect(formEntries.some(([name]) => name === 'chat_id')).toBe(true)
    expect(formEntries.some(([name]) => name === 'photo')).toBe(true)
    expect(formEntries.some(([name]) => name === 'caption')).toBe(true)

    // Verificar que caption está truncado
    const captionEntry = formEntries.find(([name]) => name === 'caption')
    expect(captionEntry[1]).toBe('A'.repeat(1024))

    unlinkSync(testFile)
  })

  it('sin TELEGRAM_BOT_TOKEN devuelve {ok:false} sin llamar fetch', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN

    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const result = await sendMessage('12345', 'test', { fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('sin TELEGRAM_BOT_TOKEN')
    expect(fetchCalled).toBe(false)
  })

  it('HTTP error devuelve {ok:false, reason} sin exponer el token', async () => {
    const fetchImpl = async () => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      }
    }

    const result = await sendMessage('12345', 'test', { fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.reason).toBeDefined()
    expect(result.reason).not.toContain('tok-test')
    expect(result.reason).not.toContain('TELEGRAM_BOT_TOKEN')
  })

  it('nunca lanza excepciones', async () => {
    const fetchImpl = async () => {
      throw new Error('network error')
    }

    // Debería manejar excepciones sin lanzar
    const result1 = await sendMessage('12345', 'test', { fetchImpl })
    expect(result1.ok).toBe(false)
    expect(result1.reason).toBeDefined()

    const testFile = join(tmpdir(), 'test-photo-' + Date.now() + '.jpg')
    writeFileSync(testFile, Buffer.from('fake'))

    const result2 = await sendPhotoFile('12345', testFile, 'caption', { fetchImpl })
    expect(result2.ok).toBe(false)
    expect(result2.reason).toBeDefined()

    unlinkSync(testFile)
  })

  it('sendPhotoFile usa fetch default si no se pasa fetchImpl', async () => {
    // Este test verifica que fetchImpl es opcional y que no lanza si está ausente
    const testFile = join(tmpdir(), 'test-photo-' + Date.now() + '.jpg')
    writeFileSync(testFile, Buffer.from('fake'))

    // Sin fetchImpl, debería intentar usar fetch global pero fallar gracefully
    const result = await sendPhotoFile('12345', testFile, 'caption')
    expect(result.ok).toBe(false)
    expect(result.reason).toBeDefined()

    unlinkSync(testFile)
  })

  it('sendMessage usa fetch default si no se pasa fetchImpl', async () => {
    // Sin fetchImpl, debería intentar usar fetch global pero fallar gracefully
    const result = await sendMessage('12345', 'test')
    expect(result.ok).toBe(false)
    expect(result.reason).toBeDefined()
  })
})
