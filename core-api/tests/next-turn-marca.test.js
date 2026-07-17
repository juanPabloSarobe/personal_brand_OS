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
})
