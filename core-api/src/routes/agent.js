import { Router } from 'express'
import { nextTurn } from '../agent/next-turn.js'

export function agentRouter(db) {
  const r = Router()
  r.post('/next-turn', async (req, res, next) => {
    try {
      const input = req.body?.input
      if (!input || !input.clase) return res.status(400).json({ error: 'falta input.clase' })
      const out = await nextTurn(db, req.user, req.user.telegram_chat_id, input, {
        fetchImpl: req.app.locals.aiFetch,
      })
      res.json(out)
    } catch (err) { next(err) }
  })
  return r
}
