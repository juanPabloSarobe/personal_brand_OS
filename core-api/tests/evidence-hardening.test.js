import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { readdirSync } from 'node:fs'
import { makeTestApp, ADMIN_CHAT } from './helpers.js'

function filesIn(dir) {
  try { return readdirSync(dir, { recursive: true }) } catch { return [] }
}

describe('hardening de evidencia', () => {
  it('rechaza base64 inválido con 400', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'foto', filename: 'x.jpg', content_base64: '!!!esto no es base64!!!' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'content_base64 inválido' })
  })

  it('si el INSERT falla, no queda archivo huérfano', async () => {
    const { app, db } = makeTestApp()
    db.exec('DROP TABLE evidence') // fuerza fallo del INSERT tras escribir el archivo
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'foto', filename: 'x.jpg', content_base64: Buffer.from('img').toString('base64') })
    expect(res.status).toBe(500)
    expect(filesIn(process.env.MEDIA_DIR)).toHaveLength(0)
  })
})
