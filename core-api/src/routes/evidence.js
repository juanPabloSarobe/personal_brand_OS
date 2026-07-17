import { Router } from 'express'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { processEvidence } from '../services/evidence-pipeline.js'
import { entitiesFor } from '../services/entities-store.js'

const TYPES = ['foto', 'audio', 'video', 'texto', 'link']
const BINARY_TYPES = ['foto', 'audio', 'video']

function isValidBase64(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

export function evidenceRouter(db) {
  const r = Router()

  r.post('/', async (req, res, next) => {
    try {
      const { type, text = null, filename = null, content_base64 = null, context = {} } = req.body
      if (!TYPES.includes(type)) return res.status(400).json({ error: `tipo inválido: ${type}` })
      if (BINARY_TYPES.includes(type) && !content_base64) {
        return res.status(400).json({ error: `${type} requiere content_base64` })
      }
      if (!BINARY_TYPES.includes(type) && !text) {
        return res.status(400).json({ error: `${type} requiere text` })
      }
      if (content_base64 && !isValidBase64(content_base64)) {
        return res.status(400).json({ error: 'content_base64 inválido' })
      }

      let filePath = null
      if (content_base64) {
        const dir = process.env.MEDIA_DIR || '/data/media'
        mkdirSync(dir, { recursive: true })
        const safeName = (filename || 'archivo.bin').replace(/[^\w.\-]/g, '_')
        filePath = path.join(dir, `${randomBytes(8).toString('hex')}-${safeName}`)
        writeFileSync(filePath, Buffer.from(content_base64, 'base64'))
      }

      let info
      try {
        info = db.prepare(`
          INSERT INTO evidence (user_id, type, file_path, text_content, context_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(req.user.id, type, filePath, text, JSON.stringify(context))
      } catch (err) {
        if (filePath) { try { unlinkSync(filePath) } catch {} }
        throw err
      }
      const id = info.lastInsertRowid
      const result = await processEvidence(db, id, { fetchImpl: req.app.locals.aiFetch })
      const fila = db.prepare('SELECT transcription, vision_description FROM evidence WHERE id = ?').get(id)
      const entities = entitiesFor(db, id)
      res.status(201).json({
        id,
        folio: `E-${String(id).padStart(4, '0')}`,
        processed: result.processed,
        detalle: {
          transcription: fila.transcription,
          vision_description: fila.vision_description,
          entities,
        },
      })
    } catch (err) {
      next(err)
    }
  })

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT id, type, file_path, text_content, transcription, vision_description, created_at
      FROM evidence WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(req.user.id)
    res.json(rows)
  })

  r.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(Number(req.params.id))
    if (!row) return res.status(404).json({ error: 'evidencia inexistente' })
    if (row.user_id !== req.user.id) return res.status(403).json({ error: 'sin acceso a la evidencia' })
    const entities = entitiesFor(db, row.id)
    res.json({ ...row, entities })
  })

  return r
}
