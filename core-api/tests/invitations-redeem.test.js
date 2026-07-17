import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'
import { crearPerfilConWaStatus } from '../src/services/editorial.js'

const MENSAJE_INVALIDO = 'Ese código no es válido o ya venció.'
const MENSAJE_SUSPENDIDO = 'Tu cuenta está suspendida.'

function admin(db) {
  return db.prepare("SELECT * FROM users WHERE telegram_chat_id = ?").get(ADMIN_CHAT)
}

// Genera una invitación real vía /invitar (mismo camino que en producción) y devuelve el código.
// Si el owner ya es dueño de un único perfil con ese nombre, /invitar la reutiliza sin
// crear una marca duplicada (evita el UNIQUE de brand_profiles.slug al pedir 2 códigos
// para la misma marca, ej. para probar re-invitación con otro rol).
async function crearInvitacion(db, { marca = 'SkyTrace', rol = 'editor' } = {}) {
  const existente = db.prepare('SELECT id FROM brand_profiles WHERE name = ?').get(marca)
  if (!existente) {
    crearPerfilConWaStatus(db, { name: marca, slug: marca.toLowerCase(), identity: {}, ownerId: admin(db).id })
  }
  const comando = rol === 'editor' ? '/invitar' : `/invitar ${rol}`
  const res = await nextTurn(db, admin(db), ADMIN_CHAT, { clase: 'comando', comando })
  const match = res.texto.match(/\/unirme ([A-Z0-9]{8})/)
  if (!match) throw new Error(`no se pudo generar invitación: ${res.texto}`)
  return match[1]
}

describe('POST /api/invitations/redeem (ruta pública, la única sin autenticación)', () => {
  it('no exige X-Telegram-Chat-Id y siempre responde 200 con {ok,texto}', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/invitations/redeem').send({ code: 'NOEXISTE', chatId: '555' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
  })

  it('code o chatId ausentes: rechazo genérico, nunca un 400/500', async () => {
    const { app } = makeTestApp()
    const res1 = await request(app).post('/api/invitations/redeem').send({ chatId: '555' })
    expect(res1.status).toBe(200)
    expect(res1.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    const res2 = await request(app).post('/api/invitations/redeem').send({ code: 'ALGO1234' })
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
  })

  it('código válido crea usuario nuevo, otorga acceso y marca la invitación usada (no reusable)', async () => {
    const { app, db } = makeTestApp()
    const code = await crearInvitacion(db, { marca: 'SkyTrace', rol: 'editor' })

    const res = await request(app).post('/api/invitations/redeem')
      .send({ code, chatId: '999', nombre: 'Nueva Persona' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.texto).toBe('✅ Listo, ya formás parte de SkyTrace como editor. Mandame una foto o un audio para empezar.')

    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '999'").get()
    expect(user).toBeTruthy()
    expect(user.name).toBe('Nueva Persona')
    expect(user.status).toBe('activo')

    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").get()
    const access = db.prepare('SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(user.id, profile.id)
    expect(access.role).toBe('editor')

    const invitation = db.prepare('SELECT * FROM invitations WHERE code = ?').get(code)
    expect(invitation.used_by).toBe(user.id)
    expect(invitation.used_at).toBeTruthy()

    // segundo intento con el mismo código: rechazado, no crea un segundo usuario
    const res2 = await request(app).post('/api/invitations/redeem').send({ code, chatId: '888' })
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    const otro = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '888'").get()
    expect(otro).toBeFalsy()
  })

  it('usuario sin nombre provisto queda como "Invitado"', async () => {
    const { app, db } = makeTestApp()
    const code = await crearInvitacion(db, { marca: 'Nimbus' })
    await request(app).post('/api/invitations/redeem').send({ code, chatId: '321' })
    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '321'").get()
    expect(user.name).toBe('Invitado')
  })

  it('código válido con usuario existente activo reutiliza la fila (no crea duplicado)', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '777', 'Persona Existente')
    const before = db.prepare('SELECT COUNT(*) n FROM users').get().n

    const code = await crearInvitacion(db, { marca: 'Aurora', rol: 'approver' })
    const res = await request(app).post('/api/invitations/redeem').send({ code, chatId: '777' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const after = db.prepare('SELECT COUNT(*) n FROM users').get().n
    expect(after).toBe(before)

    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '777'").get()
    expect(user.name).toBe('Persona Existente') // no se pisa el nombre de un usuario ya existente
    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'Aurora'").get()
    const access = db.prepare('SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(user.id, profile.id)
    expect(access.role).toBe('approver')
  })

  it('re-invitar a un usuario ya con acceso actualiza el rol (ON CONFLICT DO UPDATE)', async () => {
    const { app, db } = makeTestApp()
    const code1 = await crearInvitacion(db, { marca: 'Vega', rol: 'editor' })
    const first = await request(app).post('/api/invitations/redeem').send({ code: code1, chatId: '333' })
    expect(first.body.ok).toBe(true)

    const code2 = await crearInvitacion(db, { marca: 'Vega', rol: 'approver' })
    const second = await request(app).post('/api/invitations/redeem').send({ code: code2, chatId: '333' })
    expect(second.body.ok).toBe(true)

    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '333'").get()
    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'Vega'").get()
    const accessRows = db.prepare('SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?').all(user.id, profile.id)
    expect(accessRows).toHaveLength(1) // no duplica la fila, la actualiza
    expect(accessRows[0].role).toBe('approver')
  })

  it('SEGURIDAD: usuario suspendido es rechazado, no reactivado, y no recibe acceso ni consume la invitación', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '444', 'Suspendido')
    db.prepare("UPDATE users SET status = 'suspendido' WHERE telegram_chat_id = '444'").run()
    const code = await crearInvitacion(db, { marca: 'Halley', rol: 'editor' })

    const res = await request(app).post('/api/invitations/redeem').send({ code, chatId: '444' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_SUSPENDIDO })

    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '444'").get()
    expect(user.status).toBe('suspendido') // sigue suspendido, no se reactivó

    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'Halley'").get()
    const access = db.prepare('SELECT * FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(user.id, profile.id)
    expect(access).toBeFalsy()

    // el código sigue intacto — el rechazo fue por el usuario, no por el código, y no se "gasta"
    const invitation = db.prepare('SELECT * FROM invitations WHERE code = ?').get(code)
    expect(invitation.used_by).toBeNull()
    expect(invitation.used_at).toBeNull()
  })

  it('SEGURIDAD: código vencido es rechazado con el mensaje genérico', async () => {
    const { app, db } = makeTestApp()
    const profileId = crearPerfilConWaStatus(db, { name: 'Expirada', slug: 'expirada', identity: {}, ownerId: admin(db).id })
    db.prepare(`
      INSERT INTO invitations (code, profile_id, role, created_by, expires_at)
      VALUES ('VENCIDA1', ?, 'editor', ?, datetime('now', '-1 hour'))
    `).run(profileId, admin(db).id)

    const res = await request(app).post('/api/invitations/redeem').send({ code: 'VENCIDA1', chatId: '555' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    expect(db.prepare("SELECT * FROM users WHERE telegram_chat_id = '555'").get()).toBeFalsy()
  })

  it('SEGURIDAD: código ya usado es rechazado con el mismo mensaje genérico (no reusable)', async () => {
    const { app, db } = makeTestApp()
    const code = await crearInvitacion(db, { marca: 'Usada', rol: 'editor' })
    await request(app).post('/api/invitations/redeem').send({ code, chatId: '666' })

    const res = await request(app).post('/api/invitations/redeem').send({ code, chatId: '667' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    expect(db.prepare("SELECT * FROM users WHERE telegram_chat_id = '667'").get()).toBeFalsy()
  })

  it('SEGURIDAD: código inexistente es rechazado con el mismo mensaje genérico', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/invitations/redeem').send({ code: 'ZZZZZZZZ', chatId: '1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
  })

  it('SEGURIDAD: código inexistente, vencido y usado devuelven el TEXTO EXACTO — no habilitan enumeración', async () => {
    const { app, db } = makeTestApp()
    const profileId = crearPerfilConWaStatus(db, { name: 'Textos', slug: 'textos', identity: {}, ownerId: admin(db).id })
    db.prepare(`
      INSERT INTO invitations (code, profile_id, role, created_by, expires_at, used_by, used_at)
      VALUES ('USADA111', ?, 'editor', ?, datetime('now', '+1 hour'), ?, datetime('now'))
    `).run(profileId, admin(db).id, admin(db).id)
    db.prepare(`
      INSERT INTO invitations (code, profile_id, role, created_by, expires_at)
      VALUES ('VENCIDA2', ?, 'editor', ?, datetime('now', '-1 hour'))
    `).run(profileId, admin(db).id)

    const inexistente = await request(app).post('/api/invitations/redeem').send({ code: 'NOEXISTE', chatId: '1' })
    const usada = await request(app).post('/api/invitations/redeem').send({ code: 'USADA111', chatId: '2' })
    const vencida = await request(app).post('/api/invitations/redeem').send({ code: 'VENCIDA2', chatId: '3' })

    expect(inexistente.body.texto).toBe(MENSAJE_INVALIDO)
    expect(usada.body.texto).toBe(MENSAJE_INVALIDO)
    expect(vencida.body.texto).toBe(MENSAJE_INVALIDO)
    expect(inexistente.status).toBe(200)
    expect(usada.status).toBe(200)
    expect(vencida.status).toBe(200)
  })

  it('AISLAMIENTO: no filtra información del perfil ajeno al que apunta un código inexistente', async () => {
    const { app, db } = makeTestApp()
    // hay un perfil real en la base, pero el código no existe — la respuesta no debe
    // mencionar nombres de marca ni distinguir "perfil inexistente" de "código inválido"
    crearPerfilConWaStatus(db, { name: 'SecretaCorp', slug: 'secretacorp', identity: {}, ownerId: admin(db).id })
    const res = await request(app).post('/api/invitations/redeem').send({ code: 'NOEXISTE', chatId: '1' })
    expect(res.body.texto).not.toContain('SecretaCorp')
    expect(res.body.texto).toBe(MENSAJE_INVALIDO)
  })
})
