export function authMiddleware(db) {
  return (req, res, next) => {
    const chatId = req.get('X-Telegram-Chat-Id')
    if (!chatId) return res.status(401).json({ error: 'falta X-Telegram-Chat-Id' })
    const user = db.prepare(
      "SELECT * FROM users WHERE telegram_chat_id = ? AND status = 'activo'"
    ).get(String(chatId))
    if (!user) return res.status(403).json({ error: 'usuario no autorizado' })
    req.user = user
    next()
  }
}
