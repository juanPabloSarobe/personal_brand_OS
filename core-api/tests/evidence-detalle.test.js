import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { ADMIN_CHAT } from './helpers.js'

function makeAiApp(fetchImpl) {
  process.env.MASTER_KEY = 'ab'.repeat(32)
  process.env.ADMIN_CHAT_ID = ADMIN_CHAT
  process.env.ADMIN_NAME = 'Juan Pablo'
  process.env.GROQ_API_KEY = 'gsk-test'
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-det-'))
  process.env.MEDIA_DIR = path.join(dir, 'media')
  const db = openDb({ dbPath: path.join(dir, 'test.db') })
  return { app: createApp(db, { aiFetch: fetchImpl }), db }
}

const aiOk = async (url, opts) => {
  if (url.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'probamos SkyTrace' }) }
  const body = JSON.parse(opts.body)
  const isVision = JSON.stringify(body.messages).includes('image_url')
  const content = isVision ? 'foto del dron' : JSON.stringify({ entidades: [{ kind: 'empresa', name: 'SkyTrace' }] })
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

describe('detalle en POST /api/evidence', () => {
  it('incluye transcripción y entidades procesadas', async () => {
    const { app } = makeAiApp(aiOk)
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'audio', filename: 'n.ogg', content_base64: Buffer.from('a').toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(true)
    expect(res.body.detalle.transcription).toBe('probamos SkyTrace')
    expect(res.body.detalle.entities).toEqual([{ kind: 'empresa', name: 'SkyTrace' }])
  })

  it('con IA caída el detalle viene con nulls y processed false', async () => {
    const { app } = makeAiApp(async () => ({ ok: false, status: 503, text: async () => 'down' }))
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'hola' })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(false)
    expect(res.body.detalle).toEqual({ transcription: null, vision_description: null, entities: [] })
  })
})
