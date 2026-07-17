import express from 'express'
import { authMiddleware } from './auth.js'
import { profilesRouter } from './routes/profiles.js'

export function createApp(db) {
  const app = express()
  app.use(express.json({ limit: '50mb' })) // evidencia entra como base64
  app.get('/health', (_req, res) => res.json({ ok: true }))

  if (db) {
    const api = express.Router()
    api.use(authMiddleware(db))
    api.get('/me', (req, res) => {
      const { id, name, is_admin } = req.user
      res.json({ id, name, is_admin })
    })
    api.use('/profiles', profilesRouter(db))
    app.use('/api', api)
    app.locals.api = api // los routers de rutas se montan acá en tasks siguientes
  }

  app.locals.db = db
  return app
}
