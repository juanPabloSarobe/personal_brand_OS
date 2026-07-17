import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'

describe('autenticación', () => {
  it('401 sin header de identidad', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(401)
  })

  it('403 para chat ID desconocido (silencio administrativo)', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/api/me').set('X-Telegram-Chat-Id', '999')
    expect(res.status).toBe(403)
  })

  it('403 para usuario suspendido', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '222')
    db.prepare("UPDATE users SET status='suspendido' WHERE telegram_chat_id='222'").run()
    const res = await request(app).get('/api/me').set('X-Telegram-Chat-Id', '222')
    expect(res.status).toBe(403)
  })

  it('devuelve la identidad del usuario activo', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/api/me').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Juan Pablo')
    expect(res.body.is_admin).toBe(1)
  })
})
