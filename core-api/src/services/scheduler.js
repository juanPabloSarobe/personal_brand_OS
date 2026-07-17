import { publicar, contextoDe } from '../publishers/index.js'
import { publicarManual } from '../publishers/manual.js'
import { sendMessage } from './telegram.js'

/** Tras este número de intentos previos fallidos, se degrada a paquete manual. */
const UMBRAL_INTENTOS_DEGRADA = 3

/** Minutos de espera requeridos antes del próximo intento, según cuántos ya se hicieron. */
const MINUTOS_BACKOFF = { 1: 1, 2: 5 }

/**
 * Tope de minutos de espera entre reintentos de ENTREGA MANUAL una vez que
 * ya se decidió degradar una versión (degrade_decidido). Usa la misma
 * escalera que los reintentos normales (1min, 5min) y a partir de ahí nunca
 * baja de 15min entre intentos — así no se martilla Telegram para siempre
 * si el envío manual mismo está fallando.
 */
const TOPE_MINUTOS_BACKOFF_DEGRADE = 15

/** Marcador que se escribe en publish_log.response_json al decidir degradar. */
const MARCADOR_DEGRADE_DECIDIDO = '"degrade_decidido":true'

const VEINTICUATRO_HORAS_MS = 24 * 60 * 60 * 1000

let lastHealthRun = null

/**
 * Mutex de proceso: evita que dos llamadas a tick() se solapen (riesgo de
 * doble publicación si el tick anterior sigue en vuelo cuando dispara el
 * siguiente, p.ej. por un fetch lento). Es solo por-proceso: si algún día
 * corren múltiples contenedores/procesos de core-api en paralelo (fuera de
 * alcance para v1 — un solo contenedor por docker-compose), esto NO los
 * serializa entre sí; haría falta un lock externo (p.ej. advisory lock en
 * la DB o Redis).
 */
let tickEnProgreso = false

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

/**
 * Estado de degradación de una versión: cuenta las filas de publish_log que
 * llevan el marcador `degrade_decidido:true` (escrito por `degradar()` sin
 * importar si esa entrega manual particular tuvo éxito o no — lo que importa
 * acá es que YA se decidió degradar, no volver a llamar al canal real).
 * @param {import('better-sqlite3').Database} db
 * @param {number} versionId
 * @returns {{decidido:boolean, intentosDegrade:number, ultimoIntento:string|null, minutosDesdeUltimo:number|null}}
 */
function estadoDegradacion(db, versionId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS intentos, MAX(created_at) AS ultimo,
      (julianday('now') - julianday(MAX(created_at))) * 1440 AS minutos_desde_ultimo
    FROM publish_log
    WHERE channel_version_id = ? AND response_json LIKE ?
  `).get(versionId, `%${MARCADOR_DEGRADE_DECIDIDO}%`)

  return {
    decidido: row.intentos > 0,
    intentosDegrade: row.intentos,
    ultimoIntento: row.ultimo,
    minutosDesdeUltimo: row.minutos_desde_ultimo,
  }
}

function backoffCumplido(intentos, minutosDesdeUltimo, tope = 0) {
  if (intentos === 0) return true
  const requerido = MINUTOS_BACKOFF[intentos] ?? tope
  return minutosDesdeUltimo === null || minutosDesdeUltimo === undefined || minutosDesdeUltimo >= requerido
}

/**
 * Degrada una versión a paquete manual: manda el contenido al creador por
 * Telegram y marca `entregada_manual`. Si el envío mismo falla (p.ej.
 * Telegram caído), NO se marca como entregada — el contenido no se pierde,
 * queda `programada` para reintentar la entrega el próximo tick (con
 * backoff creciente, ver `estadoDegradacion`/`TOPE_MINUTOS_BACKOFF_DEGRADE`).
 * En ambos casos (éxito o fallo del envío manual) la fila de publish_log
 * queda marcada con `degrade_decidido:true`: la decisión de degradar ya se
 * tomó, así que ningún tick futuro debe volver a llamar al canal real.
 */
async function degradar(db, ctx, versionId, attempt, deps, motivo) {
  const manualResultado = await publicarManual(ctx, deps)
  const responseJson = { motivo, manual: manualResultado, degrade_decidido: true }

  if (!manualResultado.ok) {
    logAttempt(db, versionId, attempt, false, responseJson)
    return 'pendiente'
  }

  // Status + log son un solo hecho atómico: si el proceso muere entre medio,
  // no queremos una versión "entregada_manual" sin log o viceversa.
  db.transaction(() => {
    db.prepare("UPDATE channel_versions SET status = 'entregada_manual' WHERE id = ?").run(versionId)
    logAttempt(db, versionId, attempt, true, responseJson)
  })()

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

  const degradacion = estadoDegradacion(db, versionId)

  if (degradacion.decidido) {
    // Ya se decidió degradar esta versión (3 intentos fallidos, o degrade:true
    // explícito en cualquier intento previo). Nunca más se vuelve a llamar a
    // publicar() / al canal real — solo se reintenta la entrega manual, con
    // la misma escalera de backoff que los reintentos normales, topada en
    // TOPE_MINUTOS_BACKOFF_DEGRADE para no martillar Telegram para siempre.
    if (!backoffCumplido(degradacion.intentosDegrade, degradacion.minutosDesdeUltimo, TOPE_MINUTOS_BACKOFF_DEGRADE)) {
      return 'pendiente'
    }
    const { intentos: totalIntentos } = estadoIntentos(db, versionId)
    return degradar(db, ctx, versionId, totalIntentos + 1, deps, 'reintento de entrega manual tras degradación')
  }

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
    db.transaction(() => {
      db.prepare("UPDATE channel_versions SET status = 'publicada', published_url = ? WHERE id = ?")
        .run(resultado.url, versionId)
      logAttempt(db, versionId, attempt, true, resultado)
    })()
    if (ctx.creatorChatId) {
      await sendMessage(ctx.creatorChatId, `✅ Publicado en ${ctx.channelCode}: ${resultado.url}`, deps)
    }
    return 'publicada'
  }

  if (resultado.ok && resultado.manual) {
    db.transaction(() => {
      db.prepare("UPDATE channel_versions SET status = 'entregada_manual' WHERE id = ?").run(versionId)
      logAttempt(db, versionId, attempt, true, resultado)
    })()
    return 'degradada'
  }

  if (!resultado.ok && resultado.degrade) {
    return degradar(db, ctx, versionId, attempt, deps, resultado.reason || resultado.error || 'degradado')
  }

  // Retryable: queda logueado y programada para el próximo tick.
  // Rama defensiva no alcanzable con el contrato actual de publicar() (todo
  // resultado cae en alguna rama anterior), pero se loguea con el `ok` real
  // en vez de asumir `false` por si ese contrato cambia.
  logAttempt(db, versionId, attempt, resultado.ok, resultado)
  return 'pendiente'
}

async function tickInterno(db, deps) {
  const vencidas = db.prepare(
    "SELECT id FROM channel_versions WHERE status = 'programada' AND scheduled_at <= datetime('now')"
  ).all()

  const resumen = { procesadas: 0, publicadas: 0, degradadas: 0, reintentos_pendientes: 0 }

  for (const { id } of vencidas) {
    resumen.procesadas++
    try {
      const outcome = await procesarVersion(db, id, deps)
      if (outcome === 'publicada') resumen.publicadas++
      else if (outcome === 'degradada') resumen.degradadas++
      else if (outcome === 'pendiente') resumen.reintentos_pendientes++
      // outcome === null: idempotencia (ya no estaba 'programada') o contexto
      // faltante. `procesadas` NO tiene por qué ser igual a la suma de
      // publicadas+degradadas+reintentos_pendientes — es intencional, esos
      // casos null no le suman a ningún balde.
    } catch (err) {
      // Aislamiento por versión: una fila que lanza (DB corrupta, contexto
      // roto, lo que sea) no debe abortar el resto del lote. La contamos
      // como reintento pendiente; el status de la versión queda intacto
      // (sigue 'programada') y se reintenta en el próximo tick.
      console.error('scheduler: error procesando channel_version', id, err)
      resumen.reintentos_pendientes++
    }
  }

  await tokenHealthMaybe(db, deps)

  return resumen
}

/**
 * Recorre las channel_versions `programada` vencidas y despacha cada una:
 * publica, degrada a paquete manual o deja pendiente de reintento según
 * backoff. También dispara tokenHealthMaybe.
 *
 * Serializado por un mutex de proceso: si ya hay un tick() en curso, esta
 * llamada vuelve inmediatamente con `saltado:true` sin tocar nada (evita
 * doble publicación si un tick anterior sigue esperando un fetch lento).
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchImpl?: Function, dryRun?: boolean}} deps
 * @returns {Promise<{procesadas:number, publicadas:number, degradadas:number, reintentos_pendientes:number, saltado?:boolean}>}
 */
export async function tick(db, deps = {}) {
  if (tickEnProgreso) {
    return { procesadas: 0, publicadas: 0, degradadas: 0, reintentos_pendientes: 0, saltado: true }
  }
  tickEnProgreso = true
  try {
    return await tickInterno(db, deps)
  } finally {
    tickEnProgreso = false
  }
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
    try {
      const owners = db.prepare(`
        SELECT u.telegram_chat_id AS chat_id
        FROM user_profile_access upa
        JOIN users u ON u.id = upa.user_id
        WHERE upa.profile_id = ? AND upa.role = 'owner'
      `).all(canal.profile_id)

      for (const owner of owners) {
        try {
          await sendMessage(
            owner.chat_id,
            `🔑 El token de ${canal.channel_code} de ${canal.profile_name} vence ${canal.token_expires_at}. Reconectalo.`,
            deps
          )
        } catch (err) {
          // Un owner con problemas (chat inválido, etc.) no debe frenar el
          // aviso a los demás owners ni a los demás canales.
          console.error('scheduler: error avisando vencimiento de token a owner', owner.chat_id, err)
        }
      }
    } catch (err) {
      console.error('scheduler: error procesando aviso de vencimiento de token', canal, err)
    }
  }
}
