import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'

describe('GET /health', () => {
  it('responde 200 sin autenticación', async () => {
    const app = createApp(null) // /health no usa la db
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
