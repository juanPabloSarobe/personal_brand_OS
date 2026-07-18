import { describe, it, expect } from 'vitest'
import { makeTestApp, addUser } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'
import { crearPerfilConWaStatus } from '../src/services/editorial.js'

const CODIGO_RE = /^[A-HJ-NP-Z2-9]{8}$/ // sin 0/O/1/I

function crearPerfil(db, ownerId, name) {
  return crearPerfilConWaStatus(db, { name, slug: name.toLowerCase(), identity: {}, ownerId })
}

describe('/invitar', () => {
  it('owner de 1 perfil genera código válido en invitations con expiración a 48h (rol default editor)', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    const profileId = crearPerfil(db, admin.id, 'SkyTrace')

    const res = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/invitar' })

    expect(res.estado).toBe('inicio')
    expect(res.botones).toEqual([])
    expect(res.texto).toContain('SkyTrace')
    expect(res.texto).toContain('editor')
    expect(res.texto).toContain('/unirme')
    expect(res.texto).toContain('48 horas')

    const match = res.texto.match(/\/unirme ([A-Z0-9]{8})/)
    expect(match).toBeTruthy()
    const code = match[1]
    expect(code).toMatch(CODIGO_RE)

    const row = db.prepare('SELECT * FROM invitations WHERE code = ?').get(code)
    expect(row).toBeTruthy()
    expect(row.profile_id).toBe(profileId)
    expect(row.role).toBe('editor')
    expect(row.created_by).toBe(admin.id)
    expect(row.used_by).toBeNull()

    const check = db.prepare(`
      SELECT
        (julianday(expires_at) - julianday('now')) * 24 AS horas
      FROM invitations WHERE code = ?
    `).get(code)
    expect(check.horas).toBeGreaterThan(47.9)
    expect(check.horas).toBeLessThan(48.1)
  })

  it('rol explícito es respetado', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')

    const res = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/invitar owner' })

    expect(res.texto).toContain('owner')
    const match = res.texto.match(/\/unirme ([A-Z0-9]{8})/)
    const row = db.prepare('SELECT * FROM invitations WHERE code = ?').get(match[1])
    expect(row.role).toBe('owner')
  })

  it('rol inválido es rechazado sin insertar nada', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')

    const res = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/invitar bicho' })

    expect(res.texto).not.toContain('/unirme')
    const { n } = db.prepare('SELECT COUNT(*) n FROM invitations').get()
    expect(n).toBe(0)
  })

  it('no-owner es rechazado', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    crearPerfil(db, admin.id, 'SkyTrace')
    addUser(db, '222')
    const editor = db.prepare("SELECT * FROM users WHERE telegram_chat_id='222'").get()
    const profile = db.prepare("SELECT * FROM brand_profiles WHERE name = 'SkyTrace'").get()
    db.prepare("INSERT INTO user_profile_access (user_id, profile_id, role) VALUES (?, ?, 'editor')")
      .run(editor.id, profile.id)

    const res = await nextTurn(db, editor, '222', { clase: 'comando', comando: '/invitar' })

    expect(res.texto).toBe('🔒 No sos owner de ninguna marca.')
    const { n } = db.prepare('SELECT COUNT(*) n FROM invitations').get()
    expect(n).toBe(0)
  })

  it('owner de 2 perfiles elige con botón y el segundo turno completa la generación', async () => {
    const { db } = makeTestApp()
    const admin = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
    const p1 = crearPerfil(db, admin.id, 'SkyTrace')
    const p2 = crearPerfil(db, admin.id, 'Nimbus')

    const res1 = await nextTurn(db, admin, '111', { clase: 'comando', comando: '/invitar approver' })

    expect(res1.estado).toBe('eligiendo_perfil_invitacion')
    const ids = res1.botones.map((b) => b.id).sort()
    expect(ids).toEqual([`perfil_${p1}`, `perfil_${p2}`].sort())

    const res2 = await nextTurn(db, admin, '111', { clase: 'boton', boton: `perfil_${p2}` })

    expect(res2.estado).toBe('inicio')
    expect(res2.texto).toContain('Nimbus')
    expect(res2.texto).toContain('approver')
    const match = res2.texto.match(/\/unirme ([A-Z0-9]{8})/)
    expect(match).toBeTruthy()
    const row = db.prepare('SELECT * FROM invitations WHERE code = ?').get(match[1])
    expect(row.profile_id).toBe(p2)
    expect(row.role).toBe('approver')
  })
})
