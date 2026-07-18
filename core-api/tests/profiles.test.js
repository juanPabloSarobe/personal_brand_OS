import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'

describe('perfiles de marca', () => {
  it('admin crea un perfil y queda como owner', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'Juan Pablo', slug: 'juanpablo', identity: { tono: 'primera persona' } })
    expect(res.status).toBe(201)
    const list = await request(app).get('/api/profiles').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].role).toBe('owner')
  })

  it('no-admin no puede crear perfiles', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '222')
    const res = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', '222')
      .send({ name: 'X', slug: 'x' })
    expect(res.status).toBe(403)
  })

  it('AISLAMIENTO: el usuario B no ve ni accede al perfil de A', async () => {
    const { app, db } = makeTestApp()
    const created = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'SkyTrace', slug: 'skytrace' })
    addUser(db, '222')
    const list = await request(app).get('/api/profiles').set('X-Telegram-Chat-Id', '222')
    expect(list.body).toEqual([])
    const detail = await request(app).get(`/api/profiles/${created.body.id}`)
      .set('X-Telegram-Chat-Id', '222')
    expect(detail.status).toBe(403)
  })

  it('solo owner edita el perfil', async () => {
    const { app, db } = makeTestApp()
    const created = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'SkyTrace', slug: 'skytrace' })
    addUser(db, '222')
    const editorId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='222'").get().id
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'editor')").run(editorId, created.body.id)

    const asEditor = await request(app).put(`/api/profiles/${created.body.id}`)
      .set('X-Telegram-Chat-Id', '222').send({ name: 'Hackeado' })
    expect(asEditor.status).toBe(403)

    const asOwner = await request(app).put(`/api/profiles/${created.body.id}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ identity_json: JSON.stringify({ tono: 'nosotros' }) })
    expect(asOwner.status).toBe(200)
  })

  it('PUT acepta objetos en campos _json (los serializa)', async () => {
    const { app } = makeTestApp()
    const created = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'TestProfile', slug: 'testprofile' })
    const profileId = created.body.id

    const putRes = await request(app).put(`/api/profiles/${profileId}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ identity_json: { tono: 'nosotros' } })
    expect(putRes.status).toBe(200)

    const getRes = await request(app).get(`/api/profiles/${profileId}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(JSON.parse(getRes.body.identity_json)).toEqual({ tono: 'nosotros' })
  })

  it('errores internos no exponen stack', async () => {
    const { app } = makeTestApp()
    const created = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'TestProfile', slug: 'testprofile' })
    const profileId = created.body.id

    const putRes = await request(app).put(`/api/profiles/${profileId}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: { unexpected: 'object' } })
    expect(putRes.status).toBe(500)
    expect(putRes.body).toEqual({ error: 'error interno' })
  })

  it('slug duplicado devuelve 409 claro, no 500 genérico', async () => {
    const { app } = makeTestApp()
    const primero = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'SkyTrace', slug: 'skytrace' })
    expect(primero.status).toBe(201)

    const segundo = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'SkyTrace otra vez', slug: 'skytrace' })
    expect(segundo.status).toBe(409)
    expect(segundo.body.error).toBeTruthy()

    const list = await request(app).get('/api/profiles').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(list.body).toHaveLength(1)
  })

  it('JSON malformado devuelve 400, no 500', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .set('Content-Type', 'application/json')
      .send('{oops')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'solicitud inválida' })
  })
})
