import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'
import { decryptJson } from '../src/crypto.js'

async function withProfile(app) {
  const res = await request(app).post('/api/profiles')
    .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    .send({ name: 'Juan Pablo', slug: 'juanpablo' })
  return res.body.id
}

describe('canales del perfil', () => {
  it('conecta un canal cifrando credenciales', async () => {
    const { app, db } = makeTestApp()
    const profileId = await withProfile(app)
    const res = await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ channel_code: 'linkedin', handle: 'juanpablosarobe', credentials: { access_token: 'tok-li-1' } })
    expect(res.status).toBe(201)

    const row = db.prepare(`
      SELECT pc.* FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ? AND c.code = 'linkedin'
    `).get(profileId)
    expect(row.status).toBe('conectado')
    expect(row.credentials_enc).not.toContain('tok-li-1')       // cifrado en reposo
    expect(decryptJson(row.credentials_enc)).toEqual({ access_token: 'tok-li-1' })
  })

  it('la lista jamás devuelve credenciales', async () => {
    const { app } = makeTestApp()
    const profileId = await withProfile(app)
    await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ channel_code: 'linkedin', credentials: { access_token: 'secret-cred-xyz' } })
    const res = await request(app).get(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(res.status).toBe(200)
    expect(res.body[0].has_credentials).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('secret-cred-xyz')
    expect(res.body[0].credentials_enc).toBeUndefined()
    expect(res.body[0]).toHaveProperty('token_expires_at')
  })

  it('editor no gestiona canales (solo owner)', async () => {
    const { app, db } = makeTestApp()
    const profileId = await withProfile(app)
    addUser(db, '222')
    const editorId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='222'").get().id
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'editor')").run(editorId, profileId)
    const res = await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', '222')
      .send({ channel_code: 'linkedin', credentials: { access_token: 'x' } })
    expect(res.status).toBe(403)
  })

  it('rechaza canal inexistente en el catálogo', async () => {
    const { app } = makeTestApp()
    const profileId = await withProfile(app)
    const res = await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ channel_code: 'myspace' })
    expect(res.status).toBe(400)
  })
})
