import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT } from './helpers.js'

describe('POST /api/agent/next-turn', () => {
  it('400 sin input.clase', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/agent/next-turn')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT).send({})
    expect(res.status).toBe(400)
  })

  it('comando /cola responde siempre con texto', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/agent/next-turn')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ input: { clase: 'comando', comando: '/cola' } })
    expect(res.status).toBe(200)
    expect(res.body.texto).toBeTruthy()
    expect(res.body.estado).toBe('inicio')
    expect(Array.isArray(res.body.botones)).toBe(true)
  })

  it('403 para desconocidos (lo maneja el middleware)', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/agent/next-turn')
      .set('X-Telegram-Chat-Id', '999')
      .send({ input: { clase: 'comando', comando: '/cola' } })
    expect(res.status).toBe(403)
  })
})
