import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, INTERNAL_SECRET, addUser } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'
import { crearPerfilConWaStatus } from '../src/services/editorial.js'

const MENSAJE_INVALIDO = 'Ese código no es válido o ya venció.'
const MENSAJE_SUSPENDIDO = 'Tu cuenta está suspendida.'

// Todas las peticiones "legítimas" en este archivo mandan el secreto interno correcto
// (simula al nodo de n8n). Los tests de la sección SEGURIDAD (secreto) prueban
// explícitamente qué pasa cuando falta, es incorrecto, o no está configurado.
function redeem(app, payload) {
  return request(app).post('/api/invitations/redeem').set('X-Internal-Secret', INTERNAL_SECRET).send(payload)
}

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
    const res = await redeem(app, { code: 'NOEXISTE', chatId: '555' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
  })

  it('code o chatId ausentes: rechazo genérico, nunca un 400/500', async () => {
    const { app } = makeTestApp()
    const res1 = await redeem(app, { chatId: '555' })
    expect(res1.status).toBe(200)
    expect(res1.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    const res2 = await redeem(app, { code: 'ALGO1234' })
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
  })

  it('código válido crea usuario nuevo, otorga acceso y marca la invitación usada (no reusable)', async () => {
    const { app, db } = makeTestApp()
    const code = await crearInvitacion(db, { marca: 'SkyTrace', rol: 'editor' })

    const res = await redeem(app, { code, chatId: '999', nombre: 'Nueva Persona' })
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
    const res2 = await redeem(app, { code, chatId: '888' })
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    const otro = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '888'").get()
    expect(otro).toBeFalsy()
  })

  it('usuario sin nombre provisto queda como "Invitado"', async () => {
    const { app, db } = makeTestApp()
    const code = await crearInvitacion(db, { marca: 'Nimbus' })
    await redeem(app, { code, chatId: '321' })
    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '321'").get()
    expect(user.name).toBe('Invitado')
  })

  it('código válido con usuario existente activo reutiliza la fila (no crea duplicado)', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '777', 'Persona Existente')
    const before = db.prepare('SELECT COUNT(*) n FROM users').get().n

    const code = await crearInvitacion(db, { marca: 'Aurora', rol: 'approver' })
    const res = await redeem(app, { code, chatId: '777' })
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
    const first = await redeem(app, { code: code1, chatId: '333' })
    expect(first.body.ok).toBe(true)

    const code2 = await crearInvitacion(db, { marca: 'Vega', rol: 'approver' })
    const second = await redeem(app, { code: code2, chatId: '333' })
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

    const res = await redeem(app, { code, chatId: '444' })
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

    const res = await redeem(app, { code: 'VENCIDA1', chatId: '555' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    expect(db.prepare("SELECT * FROM users WHERE telegram_chat_id = '555'").get()).toBeFalsy()
  })

  it('SEGURIDAD: código ya usado es rechazado con el mismo mensaje genérico (no reusable)', async () => {
    const { app, db } = makeTestApp()
    const code = await crearInvitacion(db, { marca: 'Usada', rol: 'editor' })
    await redeem(app, { code, chatId: '666' })

    const res = await redeem(app, { code, chatId: '667' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })
    expect(db.prepare("SELECT * FROM users WHERE telegram_chat_id = '667'").get()).toBeFalsy()
  })

  it('SEGURIDAD: código inexistente es rechazado con el mismo mensaje genérico', async () => {
    const { app } = makeTestApp()
    const res = await redeem(app, { code: 'ZZZZZZZZ', chatId: '1' })
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

    const inexistente = await redeem(app, { code: 'NOEXISTE', chatId: '1' })
    const usada = await redeem(app, { code: 'USADA111', chatId: '2' })
    const vencida = await redeem(app, { code: 'VENCIDA2', chatId: '3' })

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
    const res = await redeem(app, { code: 'NOEXISTE', chatId: '1' })
    expect(res.body.texto).not.toContain('SecretaCorp')
    expect(res.body.texto).toBe(MENSAJE_INVALIDO)
  })

  describe('SEGURIDAD: X-Internal-Secret (cierra el secuestro de cuenta por chatId falsificado)', () => {
    it('sin el header X-Internal-Secret: rechazo genérico, byte-idéntico al de un código inválido', async () => {
      const { app, db } = makeTestApp()
      const code = await crearInvitacion(db, { marca: 'SinHeader', rol: 'editor' })

      const sinHeader = await request(app).post('/api/invitations/redeem').send({ code, chatId: '1' })
      expect(sinHeader.status).toBe(200)
      expect(sinHeader.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })

      const codigoInvalido = await request(app).post('/api/invitations/redeem').send({ code: 'NOEXISTE', chatId: '1' })
      expect(sinHeader.body).toEqual(codigoInvalido.body)

      // el código válido no se consumió — el rechazo fue por falta de secreto, no por el código
      const invitation = db.prepare('SELECT * FROM invitations WHERE code = ?').get(code)
      expect(invitation.used_by).toBeNull()
    })

    it('con el header X-Internal-Secret en un valor incorrecto: mismo rechazo genérico', async () => {
      const { app, db } = makeTestApp()
      const code = await crearInvitacion(db, { marca: 'SecretoMalo', rol: 'editor' })

      const res = await request(app).post('/api/invitations/redeem')
        .set('X-Internal-Secret', 'no-es-el-secreto-correcto')
        .send({ code, chatId: '1' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })

      const invitation = db.prepare('SELECT * FROM invitations WHERE code = ?').get(code)
      expect(invitation.used_by).toBeNull()
    })

    it('con INTERNAL_API_SECRET sin configurar en el entorno: mismo rechazo genérico (nunca "todo permitido" por defecto)', async () => {
      const { app, db } = makeTestApp()
      const code = await crearInvitacion(db, { marca: 'SinEnv', rol: 'editor' })
      delete process.env.INTERNAL_API_SECRET

      const res = await request(app).post('/api/invitations/redeem')
        .set('X-Internal-Secret', INTERNAL_SECRET) // el cliente manda el valor "correcto" de antes, pero el server ya no tiene con qué compararlo
        .send({ code, chatId: '1' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })

      const invitation = db.prepare('SELECT * FROM invitations WHERE code = ?').get(code)
      expect(invitation.used_by).toBeNull()
    })

    it('REPRODUCCIÓN DEL HALLAZGO: código válido + chatId de un usuario real ajeno, SIN el secreto correcto, no reasigna su rol', async () => {
      const { app, db } = makeTestApp()
      // víctima: usuario real ya existente con acceso a un perfil como "editor"
      addUser(db, '9999', 'Víctima Real')
      const codeVictima = await crearInvitacion(db, { marca: 'PerfilVictima', rol: 'editor' })
      const setupVictima = await redeem(app, { code: codeVictima, chatId: '9999' })
      expect(setupVictima.body.ok).toBe(true)
      const victima = db.prepare("SELECT * FROM users WHERE telegram_chat_id = '9999'").get()
      const perfilVictima = db.prepare("SELECT * FROM brand_profiles WHERE name = 'PerfilVictima'").get()
      const rolAntes = db.prepare('SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(victima.id, perfilVictima.id)
      expect(rolAntes.role).toBe('editor')

      // atacante: un código válido y sin usar, apuntado a otro perfil con rol "approver",
      // pero puesto en el body con el chatId de la víctima — exactamente la reproducción
      // en vivo del hallazgo. Sin el header correcto, esto debe fallar.
      // (perfil + invitación por SQL directo, no por /invitar: el owner ya tiene 2 perfiles
      // acá y /invitar preguntaría "¿para qué marca?" en vez de emitir el código de una)
      const profileIdAtacante = crearPerfilConWaStatus(db, { name: 'PerfilAtacante', slug: 'perfilatacante', identity: {}, ownerId: admin(db).id })
      const codeAtaque = 'ATACANTE'
      db.prepare(`
        INSERT INTO invitations (code, profile_id, role, created_by, expires_at)
        VALUES (?, ?, 'approver', ?, datetime('now', '+48 hours'))
      `).run(codeAtaque, profileIdAtacante, admin(db).id)
      const ataque = await request(app).post('/api/invitations/redeem').send({ code: codeAtaque, chatId: '9999' })
      expect(ataque.status).toBe(200)
      expect(ataque.body).toEqual({ ok: false, texto: MENSAJE_INVALIDO })

      // la víctima no ganó acceso al perfil del atacante, y su rol original sigue intacto
      const perfilAtacante = db.prepare("SELECT * FROM brand_profiles WHERE name = 'PerfilAtacante'").get()
      const accesoAtacante = db.prepare('SELECT * FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(victima.id, perfilAtacante.id)
      expect(accesoAtacante).toBeFalsy()
      const rolDespues = db.prepare('SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(victima.id, perfilVictima.id)
      expect(rolDespues.role).toBe('editor')
      // el código del atacante tampoco se consumió
      const invitacionAtaque = db.prepare('SELECT * FROM invitations WHERE code = ?').get(codeAtaque)
      expect(invitacionAtaque.used_by).toBeNull()

      // CON el secreto correcto, la misma operación es el flujo legítimo real (re-invitar
      // a un usuario existente con otro rol/perfil) y debe seguir funcionando normalmente.
      const legitimo = await redeem(app, { code: codeAtaque, chatId: '9999' })
      expect(legitimo.body.ok).toBe(true)
      const rolLegitimo = db.prepare('SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?').get(victima.id, perfilAtacante.id)
      expect(rolLegitimo.role).toBe('approver')
    })
  })

  describe('SEGURIDAD: límite de tamaño de body propio de esta ruta (10kb, no los 50mb globales de evidencia)', () => {
    it('un body de más de 10kb es rechazado y no llega a tocar la DB', async () => {
      const { app, db } = makeTestApp()
      const antes = db.prepare('SELECT COUNT(*) n FROM users').get().n

      const relleno = 'x'.repeat(20 * 1024) // 20kb, supera el límite de 10kb de esta ruta
      const res = await request(app).post('/api/invitations/redeem')
        .set('X-Internal-Secret', INTERNAL_SECRET)
        .send({ code: 'NOEXISTE', chatId: '1', nombre: relleno })

      // express.json({limit:'10kb'}) corta la petición con PayloadTooLargeError antes de
      // que llegue al handler de la ruta; el error cae en el manejador de errores genérico
      // de app.js (413, no el {ok,texto} propio de esta ruta — el handler nunca se ejecuta).
      expect(res.status).toBe(413)
      expect(res.body).toEqual({ error: 'solicitud inválida' })

      const despues = db.prepare('SELECT COUNT(*) n FROM users').get().n
      expect(despues).toBe(antes)
    })
  })
})
