import { describe, it, expect } from 'vitest'
import { makeTestApp, addUser } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'
import { crearPerfilConWaStatus } from '../src/services/editorial.js'
import { decryptJson } from '../src/crypto.js'

function crearPerfil(db, ownerId, name) {
  return crearPerfilConWaStatus(db, { name, slug: name.toLowerCase(), identity: {}, ownerId })
}

// junta todos los textos vistos en una secuencia de turnos, para el chequeo
// "nunca se ecoa el valor completo del token" al final del flujo
async function correrFlujo(db, user, chatId, pasos) {
  const textos = []
  let res
  for (const paso of pasos) {
    res = await nextTurn(db, user, chatId, paso)
    textos.push(res.texto)
  }
  return { res, textos }
}

describe('/conectar', () => {
  it('flujo completo de LinkedIn deja credenciales cifradas en profile_channels', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    const profileId = crearPerfil(db, admin.id, 'SkyTrace')

    const { res, textos } = await correrFlujo(db, admin, '111', [
      { clase: 'comando', comando: '/conectar' },
      { clase: 'boton', boton: 'conectar_linkedin' },
      { clase: 'texto', texto: 'tok-li-secretoooooaB3x' },
      { clase: 'texto', texto: 'urn:li:person:XYZ123' },
    ])

    expect(res.estado).toBe('inicio')
    expect(res.texto).toContain('LinkedIn')
    expect(res.texto).toContain('conectado')
    expect(res.texto).toContain('aB3x')

    const row = db.prepare(`
      SELECT pc.* FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ? AND c.code = 'linkedin'
    `).get(profileId)
    expect(row.status).toBe('conectado')
    expect(decryptJson(row.credentials_enc)).toEqual({
      access_token: 'tok-li-secretoooooaB3x',
      person_urn: 'urn:li:person:XYZ123',
    })

    // ningún mensaje de la secuencia contiene el token completo
    for (const t of textos) expect(t).not.toContain('tok-li-secretoooooaB3x')
  })

  it('flujo completo de Instagram deja credenciales cifradas en profile_channels', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    const profileId = crearPerfil(db, admin.id, 'SkyTrace')

    const { res, textos } = await correrFlujo(db, admin, '111', [
      { clase: 'comando', comando: '/conectar' },
      { clase: 'boton', boton: 'conectar_instagram' },
      { clase: 'texto', texto: 'ig-tok-secretoooooZZ99' },
      { clase: 'texto', texto: '17841400000000000' },
    ])

    expect(res.estado).toBe('inicio')
    expect(res.texto).toContain('Instagram')
    expect(res.texto).toContain('conectado')
    expect(res.texto).toContain('ZZ99')

    const row = db.prepare(`
      SELECT pc.* FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ? AND c.code = 'instagram'
    `).get(profileId)
    expect(row.status).toBe('conectado')
    expect(decryptJson(row.credentials_enc)).toEqual({
      access_token: 'ig-tok-secretoooooZZ99',
      ig_user_id: '17841400000000000',
    })

    for (const t of textos) expect(t).not.toContain('ig-tok-secretoooooZZ99')
  })

  it('el mensaje de confirmación intermedio no repite el valor ingresado', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')

    await nextTurn(db, admin, '111', { clase: 'comando', comando: '/conectar' })
    await nextTurn(db, admin, '111', { clase: 'boton', boton: 'conectar_linkedin' })
    const res = await nextTurn(db, admin, '111', { clase: 'texto', texto: 'valor-secreto-intermedio' })

    expect(res.estado).toBe('conectando_canal')
    expect(res.texto).not.toContain('valor-secreto-intermedio')
  })

  it('owner con 2 perfiles elige con botón antes de arrancar el flujo de canal', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    const p1 = crearPerfil(db, admin.id, 'SkyTrace')
    const p2 = crearPerfil(db, admin.id, 'Nimbus')

    const res1 = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/conectar' })
    expect(res1.estado).toBe('eligiendo_perfil_conexion')
    const ids = res1.botones.map((b) => b.id).sort()
    expect(ids).toEqual([`perfil_${p1}`, `perfil_${p2}`].sort())

    const res2 = await nextTurn(db, admin, '111', { clase: 'boton', boton: `perfil_${p2}` })
    expect(res2.estado).toBe('conectando_canal')
    const botonIds = res2.botones.map((b) => b.id).sort()
    expect(botonIds).toEqual(['conectar_instagram', 'conectar_linkedin'])

    const res3 = await nextTurn(db, admin, '111', { clase: 'boton', boton: 'conectar_linkedin' })
    await nextTurn(db, admin, '111', { clase: 'texto', texto: 'tok-nimbus-aaaa' })
    const res4 = await nextTurn(db, admin, '111', { clase: 'texto', texto: 'urn:li:person:NIMBUS' })

    expect(res4.estado).toBe('inicio')
    expect(res4.texto).toContain('LinkedIn')
    const row = db.prepare(`
      SELECT pc.* FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ? AND c.code = 'linkedin'
    `).get(p2)
    expect(row.status).toBe('conectado')
    expect(decryptJson(row.credentials_enc)).toEqual({
      access_token: 'tok-nimbus-aaaa',
      person_urn: 'urn:li:person:NIMBUS',
    })
    // el perfil 1 (SkyTrace) no fue tocado
    const rowP1 = db.prepare(`
      SELECT pc.* FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ? AND c.code = 'linkedin'
    `).get(p1)
    expect(rowP1).toBeUndefined()
    expect(res3.estado).toBe('conectando_canal')
  })

  it('no-owner es rechazado y no queda estado de conexión', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')
    addUser(db, '222')
    const editor = db.prepare("SELECT * FROM users WHERE telegram_chat_id='222'").get()
    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").get()
    db.prepare("INSERT INTO user_profile_access (user_id, profile_id, role) VALUES (?, ?, 'editor')")
      .run(editor.id, profile.id)

    const res = await nextTurn(db, editor, '222', { clase: 'comando', comando: '/conectar' })

    expect(res.texto).toBe('🔒 No sos owner de ninguna marca.')
    expect(res.estado).toBe('inicio')
  })

  it('el token completo nunca aparece en ningún mensaje de la secuencia (chequeo cruzado)', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')
    const TOKEN = 'super-secreto-que-jamas-debe-aparecer-completo-9Z8Y'

    const { textos } = await correrFlujo(db, admin, '111', [
      { clase: 'comando', comando: '/conectar' },
      { clase: 'boton', boton: 'conectar_linkedin' },
      { clase: 'texto', texto: TOKEN },
      { clase: 'texto', texto: 'urn:li:person:ABC' },
    ])

    for (const t of textos) expect(t).not.toContain(TOKEN)
  })

  it('mientras el flujo está a mitad de camino, la fila cruda de sessions no contiene el token en claro', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')
    const TOKEN = 'mitad-camino-secreto-no-debe-quedar-en-claro-Q7W'

    // /conectar -> elige LinkedIn -> pega el access_token, pero NUNCA manda el person_urn:
    // el flujo queda abandonado a mitad de camino, con el token ya en el borrador.
    await nextTurn(db, admin, '111', { clase: 'comando', comando: '/conectar' })
    await nextTurn(db, admin, '111', { clase: 'boton', boton: 'conectar_linkedin' })
    const res = await nextTurn(db, admin, '111', { clase: 'texto', texto: TOKEN })
    expect(res.estado).toBe('conectando_canal')

    const row = db.prepare(
      "SELECT data_json FROM sessions WHERE user_id = ? AND chat_id = '111'"
    ).get(admin.id)
    expect(row).toBeTruthy()

    // la fila cruda (tal como vive en el archivo sqlite) no debe contener el valor en claro
    expect(row.data_json).not.toContain(TOKEN)

    // pero descifrando el campo borrador con el helper de crypto sí aparece el valor guardado
    const data = JSON.parse(row.data_json)
    expect(typeof data.borrador).toBe('string')
    expect(decryptJson(data.borrador)).toEqual({ access_token: TOKEN })
  })
})
