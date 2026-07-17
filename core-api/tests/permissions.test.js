import { describe, it, expect } from 'vitest'
import { makeTestApp, addUser } from './helpers.js'
import { can, roleFor } from '../src/permissions.js'

function setup() {
  const { db } = makeTestApp()
  addUser(db, '222', 'Editora')
  const editor = db.prepare("SELECT id FROM users WHERE telegram_chat_id='222'").get().id
  const owner = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  const profile = db.prepare(
    "INSERT INTO brand_profiles (name, slug) VALUES ('SkyTrace', 'skytrace')"
  ).run().lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(owner, profile)
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'editor')").run(editor, profile)
  return { db, owner, editor, profile }
}

describe('matriz de permisos', () => {
  it('editor captura y edita pero NO aprueba', () => {
    const { db, editor, profile } = setup()
    expect(can(db, editor, profile, 'capturar')).toBe(true)
    expect(can(db, editor, profile, 'editar_boceto')).toBe(true)
    expect(can(db, editor, profile, 'aprobar')).toBe(false)
    expect(can(db, editor, profile, 'gestionar_canales')).toBe(false)
  })

  it('owner puede todo', () => {
    const { db, owner, profile } = setup()
    for (const a of ['ver_perfil', 'capturar', 'aprobar', 'editar_perfil', 'gestionar_canales', 'invitar']) {
      expect(can(db, owner, profile, a), a).toBe(true)
    }
  })

  it('sin fila en la matriz no hay acceso alguno', () => {
    const { db, profile } = setup()
    addUser(db, '333')
    const outsider = db.prepare("SELECT id FROM users WHERE telegram_chat_id='333'").get().id
    expect(roleFor(db, outsider, profile)).toBeNull()
    expect(can(db, outsider, profile, 'ver_perfil')).toBe(false)
  })

  it('acción desconocida lanza error (fail-closed explícito)', () => {
    const { db, owner, profile } = setup()
    expect(() => can(db, owner, profile, 'publicar_sin_aprobar')).toThrow(/desconocida/)
  })

  it('approver aprueba y programa pero no administra el perfil', () => {
    const { db, profile } = setup()
    addUser(db, '444', 'Aprobadora')
    const approver = db.prepare("SELECT id FROM users WHERE telegram_chat_id='444'").get().id
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'approver')").run(approver, profile)

    expect(can(db, approver, profile, 'aprobar')).toBe(true)
    expect(can(db, approver, profile, 'programar')).toBe(true)
    expect(can(db, approver, profile, 'capturar')).toBe(true)
    expect(can(db, approver, profile, 'editar_perfil')).toBe(false)
    expect(can(db, approver, profile, 'gestionar_canales')).toBe(false)
    expect(can(db, approver, profile, 'invitar')).toBe(false)
  })
})
