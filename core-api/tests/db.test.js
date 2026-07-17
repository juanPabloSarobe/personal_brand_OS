import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-db-'))
  return openDb({ dbPath: path.join(dir, 'test.db') })
}

describe('openDb', () => {
  beforeEach(() => {
    process.env.ADMIN_CHAT_ID = '111'
    process.env.ADMIN_NAME = 'Juan Pablo'
  })

  it('crea todas las tablas del spec', () => {
    const db = freshDb()
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name)
    for (const t of ['users', 'invitations', 'brand_profiles', 'user_profile_access',
      'channels', 'channel_formats', 'profile_channels', 'evidence', 'ideas',
      'idea_evidence', 'idea_profiles', 'drafts', 'channel_versions', 'sessions',
      'entities', 'entity_mentions', 'publish_log']) {
      expect(tables, `falta la tabla ${t}`).toContain(t)
    }
  })

  it('activa WAL y foreign keys', () => {
    const db = freshDb()
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('da de alta al admin desde el entorno, una sola vez', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-db-'))
    const dbPath = path.join(dir, 'test.db')

    // First open
    let db = openDb({ dbPath })
    db.close()

    // Second open on the same path
    db = openDb({ dbPath })

    const admin = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get('111')
    expect(admin.name).toBe('Juan Pablo')
    expect(admin.is_admin).toBe(1)
    expect(admin.status).toBe('activo')

    // Verify idempotency: only one admin with this chat_id
    const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_chat_id = ?').get('111')
    expect(count.n).toBe(1)
  })

  it('siembra el catálogo de canales del máster plan', () => {
    const db = freshDb()
    const codes = db.prepare('SELECT code, status FROM channels ORDER BY code').all()
    const byCode = Object.fromEntries(codes.map(c => [c.code, c.status]))
    expect(byCode.linkedin).toBe('activo')
    expect(byCode.instagram).toBe('activo')
    expect(byCode.wa_status).toBe('activo')
    expect(byCode.x).toBe('planificado')
    expect(byCode.tiktok).toBe('planificado')
    expect(byCode.youtube).toBe('planificado')
  })

  it('siembra formatos con bandera de automatizable', () => {
    const db = freshDb()
    const li = db.prepare(`
      SELECT f.code, f.automatable FROM channel_formats f
      JOIN channels c ON c.id = f.channel_id WHERE c.code = 'linkedin'
    `).all()
    const codes = li.map(f => f.code)
    expect(codes).toEqual(expect.arrayContaining(['texto', 'imagen', 'video', 'documento']))
    const wa = db.prepare(`
      SELECT f.automatable FROM channel_formats f
      JOIN channels c ON c.id = f.channel_id WHERE c.code = 'wa_status'
    `).get()
    expect(wa.automatable).toBe(0)
  })
})
