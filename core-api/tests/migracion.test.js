import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { makeTestApp } from './helpers.js'
import {
  createIdea, linkIdeaProfiles, createDraft, setDraftStatus, createChannelVersion, pendingFor,
} from '../src/services/editorial.js'

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
})
