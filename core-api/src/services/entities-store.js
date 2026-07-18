export function entitiesFor(db, evidenceId) {
  return db.prepare(`
    SELECT e.kind, e.name FROM entity_mentions m
    JOIN entities e ON e.id = m.entity_id
    WHERE m.evidence_id = ? ORDER BY e.id
  `).all(evidenceId)
}

export function recordMentions(db, { evidenceId = null, ideaId = null }, entities) {
  const out = []
  const upsert = db.prepare('INSERT INTO entities (kind, name) VALUES (?, ?) ON CONFLICT (kind, name) DO NOTHING')
  const find = db.prepare('SELECT id FROM entities WHERE kind = ? AND name = ?')
  const exists = db.prepare(`
    SELECT id FROM entity_mentions
    WHERE entity_id = ? AND evidence_id IS ? AND idea_id IS ?
  `)
  const mention = db.prepare('INSERT INTO entity_mentions (entity_id, evidence_id, idea_id) VALUES (?, ?, ?)')

  for (const { kind, name } of entities) {
    upsert.run(kind, name)
    const entityId = find.get(kind, name).id
    if (!exists.get(entityId, evidenceId, ideaId)) mention.run(entityId, evidenceId, ideaId)
    out.push({ entityId, kind, name })
  }
  return out
}
