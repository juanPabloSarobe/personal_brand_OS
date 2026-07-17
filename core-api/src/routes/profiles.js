import { Router } from 'express'
import { can } from '../permissions.js'
import { encryptJson } from '../crypto.js'
import { crearPerfilConWaStatus } from '../services/editorial.js'

const EDITABLE = ['name', 'identity_json', 'cadence_json', 'format_strategy_json', 'ai_overrides_json', 'visual_template']

export function profilesRouter(db) {
  const r = Router()

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.slug, p.status, a.role
      FROM brand_profiles p
      JOIN user_profile_access a ON a.profile_id = p.id
      WHERE a.user_id = ?
      ORDER BY p.id
    `).all(req.user.id)
    res.json(rows)
  })

  r.post('/', (req, res) => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'solo el administrador crea perfiles' })
    const { name, slug, identity = {} } = req.body
    if (!name || !slug) return res.status(400).json({ error: 'name y slug son requeridos' })
    const profileId = crearPerfilConWaStatus(db, { name, slug, identity, ownerId: req.user.id })
    res.status(201).json({ id: profileId })
  })

  r.get('/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'ver_perfil')) return res.status(403).json({ error: 'sin acceso al perfil' })
    const p = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(id)
    if (!p) return res.status(404).json({ error: 'perfil inexistente' })
    res.json(p)
  })

  r.put('/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'editar_perfil')) return res.status(403).json({ error: 'solo owner edita el perfil' })
    const sets = []
    const vals = []
    for (const field of EDITABLE) {
      if (field in req.body) {
        let value = req.body[field]
        if (field.endsWith('_json') && value !== null && typeof value === 'object') {
          value = JSON.stringify(value)
        }
        sets.push(`${field} = ?`)
        vals.push(value)
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' })
    vals.push(id)
    db.prepare(`UPDATE brand_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  })

  r.post('/:id/channels', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'gestionar_canales')) {
      return res.status(403).json({ error: 'solo owner gestiona canales' })
    }
    const { channel_code, handle = null, credentials = null, token_expires_at = null } = req.body
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(channel_code)
    if (!channel) return res.status(400).json({ error: `canal desconocido: ${channel_code}` })

    const enc = credentials ? encryptJson(credentials) : null
    const status = credentials ? 'conectado' : 'desconectado'
    db.prepare(`
      INSERT INTO profile_channels (profile_id, channel_id, handle, credentials_enc, status, token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile_id, channel_id) DO UPDATE SET
        handle = excluded.handle,
        credentials_enc = COALESCE(excluded.credentials_enc, credentials_enc),
        status = CASE WHEN excluded.credentials_enc IS NOT NULL THEN excluded.status ELSE profile_channels.status END,
        token_expires_at = CASE WHEN excluded.credentials_enc IS NOT NULL THEN excluded.token_expires_at ELSE profile_channels.token_expires_at END
    `).run(id, channel.id, handle, enc, status, token_expires_at)
    res.status(201).json({ ok: true })
  })

  r.get('/:id/channels', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'ver_perfil')) return res.status(403).json({ error: 'sin acceso al perfil' })
    const rows = db.prepare(`
      SELECT c.code AS channel_code, c.name AS channel_name, pc.handle, pc.status,
             pc.token_expires_at, (pc.credentials_enc IS NOT NULL) AS has_credentials
      FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ?
    `).all(id)
    res.json(rows.map(row => ({
      channel_code: row.channel_code,
      channel_name: row.channel_name,
      handle: row.handle,
      status: row.status,
      token_expires_at: row.token_expires_at,
      has_credentials: !!row.has_credentials
    })))
  })

  return r
}
