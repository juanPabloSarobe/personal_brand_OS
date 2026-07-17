import { describe, it, expect } from 'vitest'
import { makeTestApp } from './helpers.js'
import {
  createIdea, setIdeaStatus, linkIdeaProfiles, createDraft, updateDraft,
  setDraftStatus, createChannelVersion, pendingFor, connectedChannels,
} from '../src/services/editorial.js'

function setup() {
  const { db } = makeTestApp()
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(userId, profileId)
  const evId = db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid
  return { db, userId, profileId, evId }
}

describe('editorial', () => {
  it('idea con evidencia vinculada y perfiles', () => {
    const { db, userId, profileId, evId } = setup()
    const ideaId = createIdea(db, { userId, title: 'Prueba del sensor', summary: 'ok', evidenceIds: [evId] })
    expect(db.prepare('SELECT status FROM ideas WHERE id=?').get(ideaId).status).toBe('capturada')
    expect(db.prepare('SELECT COUNT(*) n FROM idea_evidence WHERE idea_id=?').get(ideaId).n).toBe(1)
    linkIdeaProfiles(db, ideaId, [profileId])
    setIdeaStatus(db, ideaId, 'en_conversacion')
    expect(db.prepare('SELECT COUNT(*) n FROM idea_profiles WHERE idea_id=?').get(ideaId).n).toBe(1)
  })

  it('draft upsert por idea+perfil y versiones', () => {
    const { db, userId, profileId, evId } = setup()
    const ideaId = createIdea(db, { userId, title: 'T', summary: null, evidenceIds: [evId] })
    const d1 = createDraft(db, { ideaId, profileId, content: 'v1', rawLlm: '{}' })
    const d2 = createDraft(db, { ideaId, profileId, content: 'v2', rawLlm: '{}' })
    expect(d1).toBe(d2)
    expect(db.prepare('SELECT content FROM drafts WHERE id=?').get(d1).content).toBe('v2')
    updateDraft(db, d1, { content: 'v3', rawLlm: '{}' })
    setDraftStatus(db, d1, 'aprobado')
    const chId = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const pcId = db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(profileId, chId).lastInsertRowid
    const vId = createChannelVersion(db, {
      draftId: d1, profileChannelId: pcId, formatCode: 'texto',
      textContent: 'v3', mediaPath: null, status: 'programada', scheduledAt: '2026-07-18 09:00:00',
    })
    expect(db.prepare('SELECT status FROM channel_versions WHERE id=?').get(vId).status).toBe('programada')
  })

  it('pendingFor junta ideas sin desarrollar, drafts en refinamiento y programadas', () => {
    const { db, userId, profileId, evId } = setup()
    const ideaId = createIdea(db, { userId, title: 'Pend', summary: null, evidenceIds: [evId] })
    linkIdeaProfiles(db, ideaId, [profileId])
    const p = pendingFor(db, userId)
    expect(p.ideas.map((i) => i.title)).toContain('Pend')
    expect(p.drafts).toEqual([])
    expect(p.programadas).toEqual([])
  })

  it('connectedChannels solo conectados', () => {
    const { db, profileId } = setup()
    const li = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const wa = db.prepare("SELECT id FROM channels WHERE code='wa_status'").get().id
    db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(profileId, li)
    db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'desconectado')").run(profileId, wa)
    const codes = connectedChannels(db, profileId).map((c) => c.code)
    expect(codes).toEqual(['linkedin'])
  })
})
