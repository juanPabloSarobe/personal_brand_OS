import { Router } from 'express'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const TYPES = ['foto', 'audio', 'video', 'texto', 'link']
const BINARY_TYPES = ['foto', 'audio', 'video']

export function evidenceRouter(db) {
  const r = Router()

  r.post('/', (req, res) => {
    const { type, text = null, filename = null, content_base64 = null, context = {} } = req.body
    if (!TYPES.includes(type)) return res.status(400).json({ error: `tipo inválido: ${type}` })
    if (BINARY_TYPES.includes(type) && !content_base64) {
      return res.status(400).json({ error: `${type} requiere content_base64` })
    }
    if (!BINARY_TYPES.includes(type) && !text) {
      return res.status(400).json({ error: `${type} requiere text` })
    }

    let filePath = null
    if (content_base64) {
      const dir = process.env.MEDIA_DIR || '/data/media'
      mkdirSync(dir, { recursive: true })
      const safeName = (filename || 'archivo.bin').replace(/[^\w.\-]/g, '_')
      filePath = path.join(dir, `${randomBytes(8).toString('hex')}-${safeName}`)
      writeFileSync(filePath, Buffer.from(content_base64, 'base64'))
    }

    const info = db.prepare(`
      INSERT INTO evidence (user_id, type, file_path, text_content, context_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, type, filePath, text, JSON.stringify(context))
    const id = info.lastInsertRowid
    res.status(201).json({ id, folio: `E-${String(id).padStart(4, '0')}` })
  })

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT id, type, file_path, text_content, transcription, vision_description, created_at
      FROM evidence WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(req.user.id)
    res.json(rows)
  })

  return r
}
