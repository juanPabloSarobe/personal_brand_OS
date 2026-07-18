import { Router } from 'express'

// Ruta pública (sin authMiddleware) — la ÚNICA del sistema. Resuelve el problema del
// huevo-y-la-gallina: alguien nuevo no puede autenticarse (no existe en `users`) para
// autenticarse. Se acota al mínimo: un solo endpoint, valida el código antes de tocar
// nada, y SIEMPRE responde 200 con {ok, texto} — nunca otro status code — para que el
// nodo de n8n que la consume no necesite lógica especial por status.
//
// Reglas de seguridad (no negociables):
// - Nunca filtra si un código existe, está usado o vencido: los tres casos devuelven
//   exactamente el mismo texto genérico, para no habilitar enumeración de códigos.
// - Un usuario `suspendido` nunca se reactiva por esta vía (se rechaza explícitamente,
//   sin tocar `user_profile_access` ni la invitación).
// - `user_profile_access` usa ON CONFLICT DO UPDATE: permite re-invitar con otro rol,
//   pero solo después de validar el código — nunca antes.
// - Sin autenticación de usuario (huevo-y-la-gallina), pero SÍ de origen: cualquiera que
//   llegue a core-api:3000 directo (contenedor hermano, host) podría mandar un chatId
//   ajeno y secuestrar el rol de un usuario real con un código válido-pero-no-usado.
//   Por eso exige X-Internal-Secret == INTERNAL_API_SECRET (compartido con n8n, nunca
//   expuesto al puente de Telegram ni al usuario final) ANTES de tocar la DB. Si falta,
//   no coincide, o INTERNAL_API_SECRET no está configurado, responde el MISMO mensaje
//   genérico que un código inválido — no se distingue el caso, para no dar un oráculo
//   nuevo (p.ej. para detectar si el secreto está mal configurado).
const MENSAJE_INVALIDO = 'Ese código no es válido o ya venció.'
const MENSAJE_SUSPENDIDO = 'Tu cuenta está suspendida.'

export function invitationsRouter(db) {
  const r = Router()

  r.post('/redeem', (req, res) => {
    const secretoEsperado = process.env.INTERNAL_API_SECRET
    const secretoRecibido = req.get('X-Internal-Secret')
    if (!secretoEsperado || secretoRecibido !== secretoEsperado) {
      return res.status(200).json({ ok: false, texto: MENSAJE_INVALIDO })
    }

    const body = req.body || {}
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    const chatId = body.chatId != null ? String(body.chatId) : ''
    const nombre = typeof body.nombre === 'string' && body.nombre.trim() ? body.nombre.trim() : null

    if (!code || !chatId) {
      return res.status(200).json({ ok: false, texto: MENSAJE_INVALIDO })
    }

    // no usada, no vencida — comparación de texto contra datetime('now'), mismo formato
    // que usa /invitar para escribir expires_at.
    const invitation = db.prepare(`
      SELECT i.*, p.name AS profile_name
      FROM invitations i
      JOIN brand_profiles p ON p.id = i.profile_id
      WHERE i.code = ? AND i.used_by IS NULL AND i.expires_at > datetime('now')
    `).get(code)

    if (!invitation) {
      return res.status(200).json({ ok: false, texto: MENSAJE_INVALIDO })
    }

    let user = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(chatId)

    if (user && user.status === 'suspendido') {
      return res.status(200).json({ ok: false, texto: MENSAJE_SUSPENDIDO })
    }

    if (!user) {
      const info = db.prepare(
        "INSERT INTO users (telegram_chat_id, name, status) VALUES (?, ?, 'activo')"
      ).run(chatId, nombre || 'Invitado')
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)
    }

    // Un solo hecho atómico: si el proceso muere entre medio, no queremos un acceso
    // otorgado con la invitación todavía "sin usar" (reutilizable) o viceversa.
    db.transaction(() => {
      db.prepare(`
        INSERT INTO user_profile_access (user_id, profile_id, role) VALUES (?, ?, ?)
        ON CONFLICT (user_id, profile_id) DO UPDATE SET role = excluded.role
      `).run(user.id, invitation.profile_id, invitation.role)

      db.prepare(
        "UPDATE invitations SET used_by = ?, used_at = datetime('now') WHERE id = ?"
      ).run(user.id, invitation.id)
    })()

    return res.status(200).json({
      ok: true,
      texto: `✅ Listo, ya formás parte de ${invitation.profile_name} como ${invitation.role}. Mandame una foto o un audio para empezar.`,
    })
  })

  return r
}
