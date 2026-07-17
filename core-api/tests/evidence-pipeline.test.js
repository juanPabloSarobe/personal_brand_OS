import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { makeTestApp } from './helpers.js'
import { processEvidence } from '../src/services/evidence-pipeline.js'

function insertEvidence(db, { type, filePath = null, text = null }) {
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  return db.prepare(
    'INSERT INTO evidence (user_id, type, file_path, text_content) VALUES (?, ?, ?, ?)'
  ).run(userId, type, filePath, text).lastInsertRowid
}

function mediaFile(name, content) {
  mkdirSync(process.env.MEDIA_DIR, { recursive: true })
  const p = path.join(process.env.MEDIA_DIR, name)
  writeFileSync(p, content)
  return p
}

function fetchRouter({ transcription = 'texto transcripto', vision = 'una foto de prueba', entidades = [] } = {}) {
  return async (url, opts) => {
    if (url.includes('/audio/transcriptions')) {
      return { ok: true, json: async () => ({ text: transcription }) }
    }
    const body = JSON.parse(opts.body)
    const isVision = JSON.stringify(body.messages).includes('image_url')
    const content = isVision ? vision : JSON.stringify({ entidades })
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  }
}

describe('pipeline de evidencia', () => {
  beforeEach(() => { process.env.GROQ_API_KEY = 'gsk-test' })

  it('audio: transcribe, extrae entidades y audita raw', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('nota.ogg', 'audio')
    const id = insertEvidence(db, { type: 'audio', filePath: p })
    const res = await processEvidence(db, id, {
      fetchImpl: fetchRouter({ transcription: 'probamos SkyTrace', entidades: [{ kind: 'empresa', name: 'SkyTrace' }] }),
    })
    expect(res.processed).toBe(true)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    expect(row.transcription).toBe('probamos SkyTrace')
    expect(row.raw_llm_json).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions WHERE evidence_id = ?').get(id).n).toBe(1)
  })

  it('foto: describe con visión', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('foto.jpg', 'img')
    const id = insertEvidence(db, { type: 'foto', filePath: p })
    const res = await processEvidence(db, id, { fetchImpl: fetchRouter({ vision: 'banco de pruebas con drones' }) })
    expect(res.processed).toBe(true)
    expect(db.prepare('SELECT vision_description FROM evidence WHERE id = ?').get(id).vision_description)
      .toBe('banco de pruebas con drones')
  })

  it('sin GROQ_API_KEY: skip sin tocar la fila', async () => {
    const { db } = makeTestApp()
    delete process.env.GROQ_API_KEY
    const id = insertEvidence(db, { type: 'texto', text: 'hola' })
    const res = await processEvidence(db, id)
    expect(res).toEqual({ processed: false, reason: 'sin GROQ_API_KEY' })
    expect(db.prepare('SELECT raw_llm_json FROM evidence WHERE id = ?').get(id).raw_llm_json).toBeNull()
  })

  it('IA caída: la evidencia queda intacta y processed false', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('nota2.ogg', 'audio')
    const id = insertEvidence(db, { type: 'audio', filePath: p })
    const res = await processEvidence(db, id, { fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }) })
    expect(res.processed).toBe(false)
    expect(res.reason).toMatch(/503/)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    expect(row.transcription).toBeNull()
    expect(JSON.parse(row.raw_llm_json).error).toMatch(/503/)
  })

  it('éxito parcial: transcripción persistida aunque fallen las entidades', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('nota3.ogg', 'audio')
    const id = insertEvidence(db, { type: 'audio', filePath: p })
    const res = await processEvidence(db, id, {
      fetchImpl: async (url) => {
        if (url.includes('/audio/transcriptions')) {
          return { ok: true, json: async () => ({ text: 'hola SkyTrace' }) }
        }
        return { ok: false, status: 500, text: async () => 'boom' }
      },
    })
    expect(res.processed).toBe(false)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    expect(row.transcription).toBe('hola SkyTrace')
    expect(JSON.parse(row.raw_llm_json).error).toBeTruthy()
  })

  it('evidencia inexistente', async () => {
    const { db } = makeTestApp()
    const res = await processEvidence(db, 9999)
    expect(res).toEqual({ processed: false, reason: 'inexistente' })
  })

  it('evidenceId inválido no lanza (regla de oro)', async () => {
    const { db } = makeTestApp()
    const res = await processEvidence(db, { malo: true })
    expect(res.processed).toBe(false)
    // the fact that we reach here and res is defined means the function did not throw
  })
})
