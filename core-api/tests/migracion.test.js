import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { makeTestApp } from './helpers.js'
import {
  createIdea, linkIdeaProfiles, createDraft, setDraftStatus, createChannelVersion, pendingFor,
} from '../src/services/editorial.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')

function freshDb() {
  process.env.ADMIN_CHAT_ID = '111'
  process.env.ADMIN_NAME = 'Juan Pablo'
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-migracion-'))
  return openDb({ dbPath: path.join(dir, 'test.db') })
}

describe('migración: índice único de versiones', () => {
  it('el índice idx_cv_draft_channel existe tras openDb fresh', () => {
    const db = freshDb()
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cv_draft_channel'"
    ).get()
    expect(idx).toBeTruthy()
  })

  it('reabrir la misma DB no falla (idempotencia)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-migracion-'))
    const dbPath = path.join(dir, 'test.db')
    let db = openDb({ dbPath })
    db.close()
    expect(() => {
      db = openDb({ dbPath })
    }).not.toThrow()
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cv_draft_channel'"
    ).get()
    expect(idx).toBeTruthy()
  })

  it('INSERT duplicado (draft_id, profile_channel_id) lanza SQLITE_CONSTRAINT', () => {
    const { db } = makeTestApp()
    const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
    const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(userId, profileId)
    const evId = db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid
    const ideaId = createIdea(db, { userId, title: 'T', summary: null, evidenceIds: [evId] })
    const draftId = createDraft(db, { ideaId, profileId, content: 'v1', rawLlm: '{}' })
    const chId = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const pcId = db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(profileId, chId).lastInsertRowid
    createChannelVersion(db, {
      draftId, profileChannelId: pcId, formatCode: 'texto', textContent: 'v1',
    })
    let err = null
    try {
      db.prepare(`
        INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content)
        VALUES (?, ?, 'texto', 'v2')
      `).run(draftId, pcId)
    } catch (e) {
      err = e
    }
    expect(err).toBeTruthy()
    expect(err.code).toMatch(/SQLITE_CONSTRAINT/)
  })

  it('pendingFor(...).aprobados lista un draft aprobado sin versiones y NO uno con versión', () => {
    const { db } = makeTestApp()
    const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
    const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(userId, profileId)
    const evId = db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid

    // draft aprobado SIN versiones -> debe aparecer
    const ideaSinVersion = createIdea(db, { userId, title: 'Sin versión', summary: null, evidenceIds: [evId] })
    linkIdeaProfiles(db, ideaSinVersion, [profileId])
    const draftSinVersion = createDraft(db, { ideaId: ideaSinVersion, profileId, content: 'x', rawLlm: '{}' })
    setDraftStatus(db, draftSinVersion, 'aprobado')

    // draft aprobado CON versión -> NO debe aparecer
    const ideaConVersion = createIdea(db, { userId, title: 'Con versión', summary: null, evidenceIds: [evId] })
    linkIdeaProfiles(db, ideaConVersion, [profileId])
    const draftConVersion = createDraft(db, { ideaId: ideaConVersion, profileId, content: 'y', rawLlm: '{}' })
    setDraftStatus(db, draftConVersion, 'aprobado')
    const chId = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const pcId = db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(profileId, chId).lastInsertRowid
    createChannelVersion(db, {
      draftId: draftConVersion, profileChannelId: pcId, formatCode: 'texto', textContent: 'y',
    })

    const p = pendingFor(db, userId)
    expect(p.aprobados.map((a) => a.id)).toContain(draftSinVersion)
    expect(p.aprobados.map((a) => a.id)).not.toContain(draftConVersion)
    const entry = p.aprobados.find((a) => a.id === draftSinVersion)
    expect(entry.profile).toBe('JP')
    expect(entry.title).toBe('Sin versión')
  })

  it('DB existente con duplicados: dedup y el índice se crea igual', () => {
    process.env.ADMIN_CHAT_ID = '111'
    process.env.ADMIN_NAME = 'Juan Pablo'
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-migracion-'))
    const dbPath = path.join(dir, 'test.db')

    // Construir la DB "a mano" replicando openDb SIN crear el índice único,
    // simulando una DB preexistente creada antes de la migración.
    const raw = new Database(dbPath)
    raw.pragma('journal_mode = WAL')
    raw.pragma('foreign_keys = ON')
    raw.exec(readFileSync(path.join(SRC, 'schema.sql'), 'utf8'))
    const seedPath = path.join(SRC, 'seed.sql')
    if (existsSync(seedPath)) raw.exec(readFileSync(seedPath, 'utf8'))

    const userId = raw.prepare(
      "INSERT INTO users (telegram_chat_id, name, status, is_admin) VALUES ('111', 'Juan Pablo', 'activo', 1)"
    ).run().lastInsertRowid
    const profileId = raw.prepare(
      "INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')"
    ).run().lastInsertRowid
    const evId = raw.prepare(
      "INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')"
    ).run(userId).lastInsertRowid
    const ideaId = raw.prepare(
      "INSERT INTO ideas (created_by, title, summary) VALUES (?, 'T', NULL)"
    ).run(userId).lastInsertRowid
    raw.prepare(
      'INSERT INTO idea_evidence (idea_id, evidence_id) VALUES (?, ?)'
    ).run(ideaId, evId)
    const draftId = raw.prepare(
      "INSERT INTO drafts (idea_id, profile_id, content) VALUES (?, ?, 'v1')"
    ).run(ideaId, profileId).lastInsertRowid
    const chId = raw.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const pcId = raw.prepare(
      "INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')"
    ).run(profileId, chId).lastInsertRowid

    // Dos versiones con el mismo (draft_id, profile_channel_id) — posible porque
    // el índice único aún no existe.
    raw.prepare(`
      INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content)
      VALUES (?, ?, 'texto', 'v1')
    `).run(draftId, pcId)
    const lastId = raw.prepare(`
      INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content)
      VALUES (?, ?, 'texto', 'v2')
    `).run(draftId, pcId).lastInsertRowid

    const idxBefore = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cv_draft_channel'"
    ).get()
    expect(idxBefore).toBeFalsy()
    raw.close()

    expect(() => openDb({ dbPath })).not.toThrow()

    const db = openDb({ dbPath })
    const rows = db.prepare('SELECT id FROM channel_versions').all()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(lastId)

    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cv_draft_channel'"
    ).get()
    expect(idx).toBeTruthy()
  })

  it('DB existente con duplicados Y publish_log referenciando la fila perdedora: openDb no debe crashear por FK', () => {
    process.env.ADMIN_CHAT_ID = '111'
    process.env.ADMIN_NAME = 'Juan Pablo'
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-migracion-'))
    const dbPath = path.join(dir, 'test.db')

    // Igual que el caso anterior, pero además la fila "perdedora" (la de menor
    // id, que el dedup por MAX(id) intentaría borrar) tiene un publish_log
    // apuntándole. Sin la fix de Fix 2, el DELETE directo de channel_versions
    // rompe la FK (no hay ON DELETE CASCADE) y openDb lanza para siempre.
    const raw = new Database(dbPath)
    raw.pragma('journal_mode = WAL')
    raw.pragma('foreign_keys = ON')
    raw.exec(readFileSync(path.join(SRC, 'schema.sql'), 'utf8'))
    const seedPath = path.join(SRC, 'seed.sql')
    if (existsSync(seedPath)) raw.exec(readFileSync(seedPath, 'utf8'))

    const userId = raw.prepare(
      "INSERT INTO users (telegram_chat_id, name, status, is_admin) VALUES ('111', 'Juan Pablo', 'activo', 1)"
    ).run().lastInsertRowid
    const profileId = raw.prepare(
      "INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')"
    ).run().lastInsertRowid
    const evId = raw.prepare(
      "INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')"
    ).run(userId).lastInsertRowid
    const ideaId = raw.prepare(
      "INSERT INTO ideas (created_by, title, summary) VALUES (?, 'T', NULL)"
    ).run(userId).lastInsertRowid
    raw.prepare(
      'INSERT INTO idea_evidence (idea_id, evidence_id) VALUES (?, ?)'
    ).run(ideaId, evId)
    const draftId = raw.prepare(
      "INSERT INTO drafts (idea_id, profile_id, content) VALUES (?, ?, 'v1')"
    ).run(ideaId, profileId).lastInsertRowid
    const chId = raw.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const pcId = raw.prepare(
      "INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')"
    ).run(profileId, chId).lastInsertRowid

    // Dos versiones con el mismo (draft_id, profile_channel_id).
    const losingId = raw.prepare(`
      INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content)
      VALUES (?, ?, 'texto', 'v1')
    `).run(draftId, pcId).lastInsertRowid
    const keepId = raw.prepare(`
      INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content)
      VALUES (?, ?, 'texto', 'v2')
    `).run(draftId, pcId).lastInsertRowid

    // publish_log referencia la fila que el dedup va a intentar borrar (losingId).
    raw.prepare(`
      INSERT INTO publish_log (channel_version_id, attempt, ok, response_json)
      VALUES (?, 1, 0, '{"error":"boom"}')
    `).run(losingId)

    raw.close()

    expect(() => openDb({ dbPath })).not.toThrow()

    const db = openDb({ dbPath })

    // Estado consistente: sin violaciones de FK.
    const fkViolations = db.pragma('foreign_key_check')
    expect(fkViolations).toEqual([])

    // El índice único se creó igual.
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cv_draft_channel'"
    ).get()
    expect(idx).toBeTruthy()

    // channel_versions quedó deduplicado: solo la fila "ganadora" (keepId) sigue viva,
    // o si el dedup no pudo aplicarse por algún motivo, ambas siguen existiendo sin
    // romper — lo que NO debe pasar es que quede una fila colgada sin su publish_log
    // apuntando a un id inexistente.
    const rows = db.prepare('SELECT id FROM channel_versions').all().map((r) => r.id)
    if (rows.length === 1) {
      expect(rows[0]).toBe(keepId)
    } else {
      expect(rows).toEqual(expect.arrayContaining([keepId, losingId]))
    }
  })
})

describe('barrido de sesiones vencidas al arrancar', () => {
  it('openDb borra sesiones ya vencidas y conserva las que siguen vigentes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-migracion-'))
    const dbPath = path.join(dir, 'test.db')
    process.env.ADMIN_CHAT_ID = '111'
    process.env.ADMIN_NAME = 'Juan Pablo'

    let db = openDb({ dbPath })
    const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id

    // sesión vencida: expires_at en el pasado.
    db.prepare(`
      INSERT INTO sessions (user_id, chat_id, state, data_json, expires_at)
      VALUES (?, 'vencida', 'conectando_canal', '{}', datetime('now', '-1 hour'))
    `).run(userId)
    // sesión vigente: expires_at en el futuro.
    db.prepare(`
      INSERT INTO sessions (user_id, chat_id, state, data_json, expires_at)
      VALUES (?, 'vigente', 'conectando_canal', '{}', datetime('now', '+1 hour'))
    `).run(userId)
    db.close()

    // reabrir la DB dispara el barrido de sesiones vencidas al arrancar
    db = openDb({ dbPath })

    const vencida = db.prepare("SELECT * FROM sessions WHERE chat_id = 'vencida'").get()
    const vigente = db.prepare("SELECT * FROM sessions WHERE chat_id = 'vigente'").get()
    expect(vencida).toBeUndefined()
    expect(vigente).toBeTruthy()
  })
})
