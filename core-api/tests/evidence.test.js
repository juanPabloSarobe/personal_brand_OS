import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { existsSync, readFileSync } from 'node:fs'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'

describe('evidencia', () => {
  it('guarda texto y devuelve folio legible', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'probamos el sensor nuevo, funcionó de una' })
    expect(res.status).toBe(201)
    expect(res.body.folio).toBe('E-0001')
  })

  it('guarda un binario en MEDIA_DIR y la ruta en la DB', async () => {
    const { app, db } = makeTestApp()
    const contenido = Buffer.from('foto-fake')
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'foto', filename: 'prueba.jpg', content_base64: contenido.toString('base64') })
    expect(res.status).toBe(201)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(res.body.id)
    expect(existsSync(row.file_path)).toBe(true)
    expect(readFileSync(row.file_path)).toEqual(contenido)
  })

  it('rechaza tipo inválido y foto sin contenido', async () => {
    const { app } = makeTestApp()
    const invalido = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT).send({ type: 'olor' })
    expect(invalido.status).toBe(400)
    const sinContenido = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT).send({ type: 'foto' })
    expect(sinContenido.status).toBe(400)
  })

  it('AISLAMIENTO: cada usuario ve solo su evidencia', async () => {
    const { app, db } = makeTestApp()
    await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'evidencia del admin' })
    addUser(db, '222')
    const res = await request(app).get('/api/evidence').set('X-Telegram-Chat-Id', '222')
    expect(res.body).toEqual([])
  })
})
