import { describe, it, expect } from 'vitest'
import { makeTestApp, addUser } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'

describe('/marca <nombre>', () => {
  it('admin crea una marca nueva con wa_status auto-conectado', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()

    const res = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/marca SkyTrace' })

    expect(res.estado).toBe('inicio')
    expect(res.botones).toEqual([])
    expect(res.texto).toContain('SkyTrace')
    expect(res.texto).toContain('creada')
    expect(res.texto).toContain('/conectar')

    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").get()
    expect(profile).toBeTruthy()
    const access = db.prepare(
      'SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?'
    ).get(admin.id, profile.id)
    expect(access.role).toBe('owner')
    const pc = db.prepare(`
      SELECT pc.status, c.code FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ?
    `).get(profile.id)
    expect(pc.code).toBe('wa_status')
    expect(pc.status).toBe('conectado')
  })

  it('no-admin no puede crear marcas: no crea nada y avisa', async () => {
    const { db } = makeTestApp()
    addUser(db, '222')
    const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id='222'").get()

    const res = await nextTurn(db, user, '222', { clase: 'comando', comando: '/marca SkyTrace' })

    expect(res.texto).toBe('🔒 Solo el administrador puede crear marcas nuevas.')
    expect(res.botones).toEqual([])
    expect(res.estado).toBe('inicio')

    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").get()
    expect(profile).toBeUndefined()
  })

  it('nombre duplicado (mismo slug): mensaje claro, no crashea, no toca el perfil existente', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()

    const primero = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/marca SkyTrace' })
    expect(primero.texto).toContain('creada')
    const original = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").get()

    const segundo = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/marca SkyTrace' })

    expect(segundo.texto).toBe('⚠️ Ya existe una marca con ese nombre (o uno muy similar). Probá con otro nombre.')
    expect(segundo.botones).toEqual([])
    expect(segundo.estado).toBe('inicio')
    // NO debe caer en el mensaje genérico y engañoso del catch top-level de nextTurn()
    expect(segundo.texto).not.toMatch(/tu material está guardado/i)

    const perfiles = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").all()
    expect(perfiles).toHaveLength(1)
    expect(perfiles[0]).toEqual(original)
  })

  it('nombre compuesto solo de emoji/símbolos: slug vacío se resuelve solo, la marca se crea igual', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()

    const res = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/marca 🚀🔥' })

    expect(res.texto).toContain('creada')
    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = '🚀🔥'").get()
    expect(profile).toBeTruthy()
    expect(profile.slug).toBeTruthy()
    expect(profile.slug.length).toBeGreaterThan(0)
  })
})
