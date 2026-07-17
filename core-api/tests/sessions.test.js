import { describe, it, expect } from 'vitest'
import { makeTestApp } from './helpers.js'
import { getSession, setSession, clearSession } from '../src/services/sessions.js'

describe('sesiones', () => {
  it('upsert y lectura', () => {
    const { db } = makeTestApp()
    setSession(db, 1, 'c1', 'proponiendo_idea', { ideaId: 7 })
    expect(getSession(db, 1, 'c1')).toEqual({ state: 'proponiendo_idea', data: { ideaId: 7 } })
    setSession(db, 1, 'c1', 'programando', {})
    expect(getSession(db, 1, 'c1').state).toBe('programando')
  })

  it('expirada devuelve null', () => {
    const { db } = makeTestApp()
    setSession(db, 1, 'c1', 'inicio', {})
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')").run()
    expect(getSession(db, 1, 'c1')).toBeNull()
  })

  it('clear borra', () => {
    const { db } = makeTestApp()
    setSession(db, 1, 'c1', 'inicio', {})
    clearSession(db, 1, 'c1')
    expect(getSession(db, 1, 'c1')).toBeNull()
  })
})
