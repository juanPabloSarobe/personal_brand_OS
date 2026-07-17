import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeAiApp(fetchImpl) {
  process.env.MASTER_KEY = 'ab'.repeat(32)
  process.env.ADMIN_CHAT_ID = ADMIN_CHAT
  process.env.ADMIN_NAME = 'Juan Pablo'
  process.env.GROQ_API_KEY = 'gsk-test'
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-ai-'))
  process.env.MEDIA_DIR = path.join(dir, 'media')
  const db = openDb({ dbPath: path.join(dir, 'test.db') })
  return { app: createApp(db, { aiFetch: fetchImpl }), db }
}

const aiOk = async (url, opts) => {
  if (url.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'probamos SkyTrace hoy' }) }
  const body = JSON.parse(opts.body)
  const isVision = JSON.stringify(body.messages).includes('image_url')
  const content = isVision ? 'foto del dron' : JSON.stringify({ entidades: [{ kind: 'empresa', name: 'SkyTrace' }] })
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

describe('integración evidencia + IA', () => {
  it('POST de audio procesa y devuelve processed true', async () => {
    const { app, db } = makeAiApp(aiOk)
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'audio', filename: 'nota.ogg', content_base64: Buffer.from('audio').toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(true)
    const row = db.prepare('SELECT transcription FROM evidence WHERE id = ?').get(res.body.id)
    expect(row.transcription).toBe('probamos SkyTrace hoy')
  })

  it('GET /:id devuelve la evidencia con sus entidades', async () => {
    const { app } = makeAiApp(aiOk)
    const created = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'reunión con SkyTrace' })
    const res = await request(app).get(`/api/evidence/${created.body.id}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(res.status).toBe(200)
    expect(res.body.entities).toEqual([{ kind: 'empresa', name: 'SkyTrace' }])
  })

  it('GET /:id ajeno → 403; inexistente → 404', async () => {
    const { app, db } = makeAiApp(aiOk)
    const created = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'privado' })
    addUser(db, '222')
    const ajeno = await request(app).get(`/api/evidence/${created.body.id}`).set('X-Telegram-Chat-Id', '222')
    expect(ajeno.status).toBe(403)
    const nada = await request(app).get('/api/evidence/99999').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(nada.status).toBe(404)
  })

  it('IA caída: el POST igual guarda (processed false)', async () => {
    const { app, db } = makeAiApp(async () => ({ ok: false, status: 503, text: async () => 'down' }))
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'audio', filename: 'n.ogg', content_base64: Buffer.from('a').toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n).toBe(1)
  })

  it('makeTestApp sigue funcionando sin aiFetch (sin GROQ_API_KEY no procesa)', async () => {
    const { app } = makeTestApp()
    delete process.env.GROQ_API_KEY
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'sin ia' })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(false)
  })
})
