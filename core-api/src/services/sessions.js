export function getSession(db, userId, chatId) {
  const row = db.prepare(`
    SELECT state, data_json FROM sessions
    WHERE user_id = ? AND chat_id = ? AND expires_at > datetime('now')
  `).get(userId, String(chatId))
  return row ? { state: row.state, data: JSON.parse(row.data_json) } : null
}

export function setSession(db, userId, chatId, state, data = {}) {
  db.prepare(`
    INSERT INTO sessions (user_id, chat_id, state, data_json, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+2 hours'))
    ON CONFLICT (user_id, chat_id) DO UPDATE SET
      state = excluded.state, data_json = excluded.data_json, expires_at = excluded.expires_at
  `).run(userId, String(chatId), state, JSON.stringify(data))
}

export function clearSession(db, userId, chatId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND chat_id = ?').run(userId, String(chatId))
}
