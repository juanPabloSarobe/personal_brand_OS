import { describe, it, expect } from 'vitest'
import { makeTestApp } from './helpers.js'
import { recordMentions } from '../src/services/entities-store.js'

function withEvidence(db) {
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  return db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid
}

describe('almacén de entidades', () => {
  it('crea entidades nuevas y registra menciones', () => {
    const { db } = makeTestApp()
    const evId = withEvidence(db)
    const out = recordMentions(db, { evidenceId: evId }, [
      { kind: 'empresa', name: 'SkyTrace' },
      { kind: 'lugar', name: 'Polo Tecnológico' },
    ])
    expect(out).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions WHERE evidence_id = ?').get(evId).n).toBe(2)
  })

  it('reutiliza la entidad existente (upsert por kind+name)', () => {
    const { db } = makeTestApp()
    const ev1 = withEvidence(db)
    const ev2 = withEvidence(db)
    recordMentions(db, { evidenceId: ev1 }, [{ kind: 'empresa', name: 'SkyTrace' }])
    recordMentions(db, { evidenceId: ev2 }, [{ kind: 'empresa', name: 'SkyTrace' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions').get().n).toBe(2)
  })

  it('no duplica la mención de la misma entidad en la misma evidencia', () => {
    const { db } = makeTestApp()
    const evId = withEvidence(db)
    recordMentions(db, { evidenceId: evId }, [{ kind: 'empresa', name: 'SkyTrace' }])
    recordMentions(db, { evidenceId: evId }, [{ kind: 'empresa', name: 'SkyTrace' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions WHERE evidence_id = ?').get(evId).n).toBe(1)
  })
})
