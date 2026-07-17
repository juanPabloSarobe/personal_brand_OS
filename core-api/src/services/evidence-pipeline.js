import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transcribe, describeImage } from '../ai/client.js'
import { extractEntities } from '../ai/entities.js'
import { recordMentions } from './entities-store.js'

const MIMES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

export async function processEvidence(db, evidenceId, { fetchImpl } = {}) {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId)
  if (!ev) return { processed: false, reason: 'inexistente' }
  if (!process.env.GROQ_API_KEY) return { processed: false, reason: 'sin GROQ_API_KEY' }

  const raws = {}
  try {
    let transcription = null
    let vision = null

    if (ev.type === 'audio' && ev.file_path) {
      const r = await transcribe(readFileSync(ev.file_path), path.basename(ev.file_path), { fetchImpl })
      transcription = r.text
      raws.transcripcion = r.raw
      db.prepare('UPDATE evidence SET transcription = ? WHERE id = ?').run(transcription, ev.id)
    }

    if (ev.type === 'foto' && ev.file_path) {
      const mime = MIMES[path.extname(ev.file_path).toLowerCase()] || 'image/jpeg'
      const r = await describeImage(readFileSync(ev.file_path), mime, { fetchImpl })
      vision = r.content
      raws.vision = r.raw
      db.prepare('UPDATE evidence SET vision_description = ? WHERE id = ?').run(vision, ev.id)
    }

    const fullText = [ev.text_content, transcription, vision].filter(Boolean).join('\n')
    if (fullText.trim()) {
      const r = await extractEntities(fullText, { fetchImpl })
      raws.entidades = r.raw
      recordMentions(db, { evidenceId: ev.id }, r.entities)
    }

    db.prepare('UPDATE evidence SET raw_llm_json = ? WHERE id = ?').run(JSON.stringify(raws), ev.id)
    return { processed: true }
  } catch (err) {
    db.prepare('UPDATE evidence SET raw_llm_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...raws, error: String(err) }), ev.id)
    return { processed: false, reason: String(err) }
  }
}
