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
    const db = freshDb()
    const admin = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get('111')
    expect(admin.name).toBe('Juan Pablo')
    expect(admin.is_admin).toBe(1)
    expect(admin.status).toBe('activo')
  })
})
