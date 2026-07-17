import { publicar, contextoDe } from '../publishers/index.js'
import { publicarManual } from '../publishers/manual.js'
import { sendMessage } from './telegram.js'

/** Tras este número de intentos previos fallidos, se degrada a paquete manual. */
const UMBRAL_INTENTOS_DEGRADA = 3

/** Minutos de espera requeridos antes del próximo intento, según cuántos ya se hicieron. */
const MINUTOS_BACKOFF = { 1: 1, 2: 5 }

const VEINTICUATRO_HORAS_MS = 24 * 60 * 60 * 1000

let lastHealthRun = null

/** Solo para tests: fuerza que la próxima llamada a tokenHealthMaybe corra de nuevo. */
export function _resetHealthClock() {
  lastHealthRun = null
}

function logAttempt(db, versionId, attempt, ok, resultado) {
  db.prepare(
    'INSERT INTO publish_log (channel_version_id, attempt, ok, response_json) VALUES (?, ?, ?, ?)'
  ).run(versionId, attempt, ok ? 1 : 0, JSON.stringify(resultado ?? {}))
}

function estadoIntentos(db, versionId) {
  return db.prepare(`
    SELECT COUNT(*) AS intentos, MAX(created_at) AS ultimo,
      (julianday('now') - julianday(MAX(created_at))) * 1440 AS minutos_desde_ultimo
    FROM publish_log WHERE channel_version_id = ?
  `).get(versionId)
}

function backoffCumplido(intentos, minutosDesdeUltimo) {
  if (intentos === 0) return true
  const requerido = MINUTOS_BACKOFF[intentos] ?? 0
  return minutosDesdeUltimo === null || minutosDesdeUltimo === undefined || minutosDesdeUltimo >= requerido
}

/**
 * Degrada una versión a paquete manual: manda el contenido al creador por
 * Telegram y marca `entregada_manual`. Si el envío mismo falla (p.ej.
 * Telegram caído), NO se marca como entregada — el contenido no se pierde,
 * queda `programada` para reintentar la entrega el próximo tick.
 */
async function degradar(db, ctx, versionId, attempt, deps, motivo) {
  const manualResultado = await publicarManual(ctx, deps)
  logAttempt(db, versionId, attempt, manualResultado.ok, { motivo, manual: manualResultado })

  if (!manualResultado.ok) {
    return 'pendiente'
  }

  db.prepare("UPDATE channel_versions SET status = 'entregada_manual' WHERE id = ?").run(versionId)

  if (ctx.creatorChatId) {
    await sendMessage(
      ctx.creatorChatId,
      `⚠️ ${ctx.channelCode} no respondió; te mandé el paquete para publicarlo a mano.`,
      deps
    )
  }
  return 'degradada'
}

async function procesarVersion(db, versionId, deps) {
  // Idempotencia dura: si algo ya movió el estado, no tocar.
  const actual = db.prepare('SELECT status FROM channel_versions WHERE id = ?').get(versionId)
  if (!actual || actual.status !== 'programada') return null

  const ctx = contextoDe(db, versionId)
  if (!ctx) return null

  const { intentos, minutos_desde_ultimo: minutosDesdeUltimo } = estadoIntentos(db, versionId)
  const attempt = intentos + 1

  if (intentos >= UMBRAL_INTENTOS_DEGRADA) {
    return degradar(db, ctx, versionId, attempt, deps, `${intentos} intentos fallidos`)
  }

  if (!backoffCumplido(intentos, minutosDesdeUltimo)) {
    return 'pendiente'
  }

  const resultado = await publicar(db, ctx.version, deps)

  if (resultado.ok && resultado.url) {
    db.prepare("UPDATE channel_versions SET status = 'publicada', published_url = ? WHERE id = ?")
      .run(resultado.url, versionId)
    logAttempt(db, versionId, attempt, true, resultado)
    if (ctx.creatorChatId) {
      await sendMessage(ctx.creatorChatId, `✅ Publicado en ${ctx.channelCode}: ${resultado.url}`, deps)
    }
    return 'publicada'
  }

  if (resultado.ok && resultado.manual) {
    db.prepare("UPDATE channel_versions SET status = 'entregada_manual' WHERE id = ?").run(versionId)
    logAttempt(db, versionId, attempt, true, resultado)
    return 'degradada'
  }

  if (!resultado.ok && resultado.degrade) {
    return degradar(db, ctx, versionId, attempt, deps, resultado.reason || resultado.error || 'degradado')
  }

  // Retryable: queda logueado y programada para el próximo tick.
  logAttempt(db, versionId, attempt, false, resultado)
  return 'pendiente'
}

/**
 * Recorre las channel_versions `programada` vencidas y despacha cada una:
 * publica, degrada a paquete manual o deja pendiente de reintento según
 * backoff. También dispara tokenHealthMaybe.
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: Function, dryRun?: boolean}} deps
 * @returns {Promise<{procesadas:number, publicadas:number, degradadas:number, reintentos_pendientes:number}>}
 */
export async function tick(db, deps = {}) {
  const vencidas = db.prepare(
    "SELECT id FROM channel_versions WHERE status = 'programada' AND scheduled_at <= datetime('now')"
  ).all()

  const resumen = { procesadas: 0, publicadas: 0, degradadas: 0, reintentos_pendientes: 0 }

  for (const { id } of vencidas) {
    resumen.procesadas++
    const outcome = await procesarVersion(db, id, deps)
    if (outcome === 'publicada') resumen.publicadas++
    else if (outcome === 'degradada') resumen.degradadas++
    else if (outcome === 'pendiente') resumen.reintentos_pendientes++
  }

  await tokenHealthMaybe(db, deps)

  return resumen
}

/**
 * Una vez cada 24h (reloj en memoria del proceso): avisa a los owners de
 * cada perfil cuando un canal conectado tiene el token por vencer en ≤7 días.
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: Function}} deps
 */
export async function tokenHealthMaybe(db, deps = {}) {
  const ahora = Date.now()
  if (lastHealthRun !== null && ahora - lastHealthRun < VEINTICUATRO_HORAS_MS) {
    return
  }
  lastHealthRun = ahora

  const porVencer = db.prepare(`
    SELECT pc.profile_id AS profile_id, pc.token_expires_at AS token_expires_at,
           c.code AS channel_code, bp.name AS profile_name
    FROM profile_channels pc
    JOIN channels c ON c.id = pc.channel_id
    JOIN brand_profiles bp ON bp.id = pc.profile_id
    WHERE pc.status = 'conectado'
      AND pc.token_expires_at IS NOT NULL
      AND pc.token_expires_at <= datetime('now', '+7 days')
  `).all()

  for (const canal of porVencer) {
    const owners = db.prepare(`
      SELECT u.telegram_chat_id AS chat_id
      FROM user_profile_access upa
      JOIN users u ON u.id = upa.user_id
      WHERE upa.profile_id = ? AND upa.role = 'owner'
    `).all(canal.profile_id)

    for (const owner of owners) {
      await sendMessage(
        owner.chat_id,
        `🔑 El token de ${canal.channel_code} de ${canal.profile_name} vence ${canal.token_expires_at}. Reconectalo.`,
        deps
      )
    }
  }
}
