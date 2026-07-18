import Database from 'better-sqlite3'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function openDb({ dbPath = process.env.DB_PATH || '/data/pbos.db' } = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const hasUsers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  ).get()
  if (!hasUsers) {
    db.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'))
    const seedPath = path.join(HERE, 'seed.sql')
    if (existsSync(seedPath)) db.exec(readFileSync(seedPath, 'utf8'))
  }

  // Dedup de channel_versions duplicadas (draft_id, profile_channel_id) previo a
  // crear el índice único de abajo. Se guarda todo (borrado de publish_log
  // huérfano + dedup + creación de índice) en un único try/catch: si una fila
  // "perdedora" (no-MAX) tiene publish_log referenciándola, el DELETE directo
  // rompería la FK (no hay ON DELETE CASCADE) y tumbaría el arranque para
  // siempre. Por eso primero limpiamos publish_log de esas filas.
  // TODO(hardening futuro): en vez de MAX(id) a secas, preferir conservar la
  // fila con el status más avanzado (publicada > entregada_manual >
  // programada > aprobada > pendiente > cancelada) para no perder por
  // accidente una versión ya publicada si quedó con un id menor.
  try {
    db.exec(`
      DELETE FROM publish_log
      WHERE channel_version_id IN (
        SELECT id FROM channel_versions
        WHERE id NOT IN (
          SELECT MAX(id) FROM channel_versions GROUP BY draft_id, profile_channel_id
        )
      )
    `)
    db.exec(`
      DELETE FROM channel_versions
      WHERE id NOT IN (
        SELECT MAX(id) FROM channel_versions GROUP BY draft_id, profile_channel_id
      )
    `)
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_draft_channel ON channel_versions(draft_id, profile_channel_id)")
  } catch (err) {
    console.error('no se pudo deduplicar channel_versions / crear idx_cv_draft_channel:', err)
  }

  // Barrido de sesiones vencidas. getSession ya filtra por expires_at en la lectura,
  // pero nada borraba las filas vencidas — un flujo abandonado (ej. /conectar a mitad
  // de camino) quedaba en sessions.data_json indefinidamente hasta que ese mismo
  // user+chat arrancara otro flujo y pisara la fila. Este barrido solo corre al
  // arrancar (cada openDb), no es un sweep continuo/periódico — alcance v1 aceptado
  // porque el filtro por TTL en lectura ya cubre el resto del tiempo de vida del proceso.
  try {
    db.exec("DELETE FROM sessions WHERE expires_at <= datetime('now')")
  } catch (err) {
    console.error('no se pudo barrer sesiones vencidas:', err)
  }

  ensureAdmin(db)
  return db
}

function ensureAdmin(db) {
  if (!process.env.INTERNAL_API_SECRET) {
    console.warn('INTERNAL_API_SECRET no configurado: la redencion de invitaciones fallara silenciosamente hasta que se defina en .env')
  }
  const chatId = process.env.ADMIN_CHAT_ID
  if (!chatId) {
    console.warn('ADMIN_CHAT_ID no configurado: no se creó usuario administrador')
    return
  }
  const exists = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(String(chatId))
  if (!exists) {
    db.prepare(
      "INSERT INTO users (telegram_chat_id, name, status, is_admin) VALUES (?, ?, 'activo', 1)"
    ).run(String(chatId), process.env.ADMIN_NAME || 'Admin')
  }
}
