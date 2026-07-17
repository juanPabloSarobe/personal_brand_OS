import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'

export const ADMIN_CHAT = '111'

export function makeTestApp() {
  process.env.MASTER_KEY = 'ab'.repeat(32)
  process.env.ADMIN_CHAT_ID = ADMIN_CHAT
  process.env.ADMIN_NAME = 'Juan Pablo'
  delete process.env.GROQ_API_KEY
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-'))
  process.env.MEDIA_DIR = path.join(dir, 'media')
  const db = openDb({ dbPath: path.join(dir, 'test.db') })
  return { app: createApp(db), db }
}

/** Da de alta un usuario activo y devuelve su chat_id. */
export function addUser(db, chatId, name = `Usuario ${chatId}`) {
  db.prepare(
    "INSERT INTO users (telegram_chat_id, name, status) VALUES (?, ?, 'activo')"
  ).run(String(chatId), name)
  return String(chatId)
}
