export function createIdea(db, { userId, title, summary = null, evidenceIds = [] }) {
  const id = db.prepare(
    'INSERT INTO ideas (created_by, title, summary) VALUES (?, ?, ?)'
  ).run(userId, title, summary).lastInsertRowid
  const link = db.prepare('INSERT INTO idea_evidence (idea_id, evidence_id) VALUES (?, ?)')
  for (const evId of evidenceIds) link.run(id, evId)
  return id
}

export function setIdeaStatus(db, ideaId, status) {
  db.prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, ideaId)
}

export function linkIdeaProfiles(db, ideaId, profileIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO idea_profiles (idea_id, profile_id) VALUES (?, ?)')
  for (const p of profileIds) ins.run(ideaId, p)
}

export function createDraft(db, { ideaId, profileId, content, rawLlm = null }) {
  db.prepare(`
    INSERT INTO drafts (idea_id, profile_id, content, raw_llm_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (idea_id, profile_id) DO UPDATE SET
      content = excluded.content, raw_llm_json = excluded.raw_llm_json, status = 'en_refinamiento'
  `).run(ideaId, profileId, content, rawLlm)
  return db.prepare('SELECT id FROM drafts WHERE idea_id = ? AND profile_id = ?').get(ideaId, profileId).id
}

export function updateDraft(db, draftId, { content, rawLlm = null }) {
  db.prepare('UPDATE drafts SET content = ?, raw_llm_json = ? WHERE id = ?').run(content, rawLlm, draftId)
}

export function setDraftStatus(db, draftId, status) {
  db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, draftId)
}

export function createChannelVersion(db, { draftId, profileChannelId, formatCode, textContent, mediaPath = null, hashtags = null, status = 'pendiente', scheduledAt = null }) {
  return db.prepare(`
    INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content, media_path, hashtags, status, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(draftId, profileChannelId, formatCode, textContent, mediaPath, hashtags, status, scheduledAt).lastInsertRowid
}

export function pendingFor(db, userId) {
  const ideas = db.prepare(`
    SELECT i.id, i.title, i.status FROM ideas i
    WHERE i.created_by = ? AND i.status IN ('capturada', 'en_conversacion')
    ORDER BY i.id DESC
  `).all(userId)
  const drafts = db.prepare(`
    SELECT d.id, d.status, p.name AS profile, i.title FROM drafts d
    JOIN brand_profiles p ON p.id = d.profile_id
    JOIN ideas i ON i.id = d.idea_id
    WHERE i.created_by = ? AND d.status = 'en_refinamiento'
    ORDER BY d.id DESC
  `).all(userId)
  const programadas = db.prepare(`
    SELECT v.id, v.format_code, v.scheduled_at, c.code AS channel FROM channel_versions v
    JOIN drafts d ON d.id = v.draft_id
    JOIN ideas i ON i.id = d.idea_id
    JOIN profile_channels pc ON pc.id = v.profile_channel_id
    JOIN channels c ON c.id = pc.channel_id
    WHERE i.created_by = ? AND v.status = 'programada'
    ORDER BY v.scheduled_at
  `).all(userId)
  return { ideas, drafts, programadas }
}

export function connectedChannels(db, profileId) {
  return db.prepare(`
    SELECT pc.id, c.code FROM profile_channels pc
    JOIN channels c ON c.id = pc.channel_id
    WHERE pc.profile_id = ? AND pc.status = 'conectado'
    ORDER BY c.id
  `).all(profileId)
}
