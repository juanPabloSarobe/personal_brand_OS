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

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_draft_channel ON channel_versions(draft_id, profile_channel_id)")

  ensureAdmin(db)
  return db
}

function ensureAdmin(db) {
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
