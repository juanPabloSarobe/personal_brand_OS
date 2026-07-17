import express from 'express'
import { authMiddleware } from './auth.js'
import { profilesRouter } from './routes/profiles.js'
import { evidenceRouter } from './routes/evidence.js'
import { agentRouter } from './routes/agent.js'
import { invitationsRouter } from './routes/invitations.js'

export function createApp(db, { aiFetch } = {}) {
  const app = express()
  app.get('/health', (_req, res) => res.json({ ok: true }))

  if (db) {
    // ÚNICA ruta pública del sistema (sin authMiddleware) — montada ANTES del router
    // autenticado para que la petición nunca llegue a authMiddleware. Ver invitations.js.
    // Body parser propio y chico (10kb, sobra para {code, chatId, nombre}): esta ruta no
    // tiene autenticación, así que el límite de 50mb pensado para evidencia (más abajo)
    // sería una superficie de amplificación de DoS gratuita acá. El matching de Express
    // es por path, así que esto pisa el límite global solo para /api/invitations.
    app.use('/api/invitations', express.json({ limit: '10kb' }), invitationsRouter(db))

    app.use(express.json({ limit: '50mb' })) // evidencia entra como base64

    const api = express.Router()
    api.use(authMiddleware(db))
    api.get('/me', (req, res) => {
      const { id, name, is_admin } = req.user
      res.json({ id, name, is_admin })
    })
    api.use('/profiles', profilesRouter(db))
    api.use('/evidence', evidenceRouter(db))
    api.use('/agent', agentRouter(db))
    app.use('/api', api)
    app.locals.api = api // los routers de rutas se montan acá en tasks siguientes
    app.locals.aiFetch = aiFetch
  }

  app.use((err, _req, res, _next) => {
    const status = err.status && err.status < 500 ? err.status : 500
    if (status >= 500) console.error(err)
    res.status(status).json({ error: status >= 500 ? 'error interno' : 'solicitud inválida' })
  })

  app.locals.db = db
  return app
}
