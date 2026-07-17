import express from 'express'

export function createApp(db) {
  const app = express()
  app.use(express.json({ limit: '50mb' })) // evidencia entra como base64
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.locals.db = db
  return app
}
