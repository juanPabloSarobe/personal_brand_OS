import { Router } from 'express'
import { can } from '../permissions.js'

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
    const info = db.prepare(
      'INSERT INTO brand_profiles (name, slug, identity_json) VALUES (?, ?, ?)'
    ).run(name, slug, JSON.stringify(identity))
    db.prepare(
      "INSERT INTO user_profile_access (user_id, profile_id, role) VALUES (?, ?, 'owner')"
    ).run(req.user.id, info.lastInsertRowid)
    res.status(201).json({ id: info.lastInsertRowid })
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
      if (field in req.body) { sets.push(`${field} = ?`); vals.push(req.body[field]) }
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' })
    vals.push(id)
    db.prepare(`UPDATE brand_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  })

  return r
}
