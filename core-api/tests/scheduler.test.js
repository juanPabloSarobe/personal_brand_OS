import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestApp, ADMIN_CHAT } from './helpers.js'
import { createIdea, linkIdeaProfiles, createDraft, createChannelVersion } from '../src/services/editorial.js'
import { encryptJson } from '../src/crypto.js'
import { tick, tokenHealthMaybe, _resetHealthClock } from '../src/services/scheduler.js'

/** Construye idea -> draft -> profile_channel -> channel_version 'programada' vencida. */
function buildFixture(db, {
  channelCode = 'linkedin',
  credentials = { access_token: 'tok', person_urn: 'urn:li:person:abc' },
  mediaPath = null,
  hashtags = '#test',
  status = 'programada',
  scheduledAtExpr = "datetime('now', '-2 minutes')",
} = {}) {
  const userId = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(ADMIN_CHAT).id
  const slug = 'jp-' + Math.random().toString(36).slice(2)
  const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP', ?)").run(slug).lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(userId, profileId)

  const chId = db.prepare('SELECT id FROM channels WHERE code = ?').get(channelCode).id
  const credEnc = credentials ? encryptJson(credentials) : null
  const pcId = db.prepare(
    "INSERT INTO profile_channels (profile_id, channel_id, status, credentials_enc) VALUES (?, ?, 'conectado', ?)"
  ).run(profileId, chId, credEnc).lastInsertRowid

  const evId = db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid
  const ideaId = createIdea(db, { userId, title: 'Idea de prueba', summary: null, evidenceIds: [evId] })
  linkIdeaProfiles(db, ideaId, [profileId])
  const draftId = createDraft(db, { ideaId, profileId, content: 'contenido', rawLlm: '{}' })
  const versionId = createChannelVersion(db, {
    draftId, profileChannelId: pcId, formatCode: 'texto', textContent: 'Texto de prueba',
    mediaPath, hashtags, status,
  })
  db.prepare(`UPDATE channel_versions SET scheduled_at = ${scheduledAtExpr} WHERE id = ?`).run(versionId)

  return { userId, profileId, pcId, ideaId, draftId, versionId }
}

/** Inserta una fila de publish_log con created_at controlado (para simular backoff). */
function logAttemptAt(db, versionId, attempt, ok, createdAtExpr) {
  db.prepare(`
    INSERT INTO publish_log (channel_version_id, attempt, ok, response_json, created_at)
    VALUES (?, ?, ?, '{}', ${createdAtExpr})
  `).run(versionId, attempt, ok ? 1 : 0)
}

/**
 * Inserta una fila de publish_log ya marcada `degrade_decidido:true` (como
 * las que escribe degradar()), con created_at controlado, para sembrar
 * directamente un estado de degradación ya decidido sin pasar por el flujo
 * real de publicación/degradación.
 */
function logDegradeAttemptAt(db, versionId, attempt, createdAtExpr) {
  const responseJson = JSON.stringify({ motivo: 'seed', manual: { ok: false }, degrade_decidido: true })
  db.prepare(`
    INSERT INTO publish_log (channel_version_id, attempt, ok, response_json, created_at)
    VALUES (?, ?, 0, ?, ${createdAtExpr})
  `).run(versionId, attempt, responseJson)
}

describe('scheduler: reintentos y degradación', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok-test'
    _resetHealthClock()
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.DRY_RUN
    delete process.env.MEDIA_PUBLIC_BASE_URL
  })

  it('programada vencida se publica (linkedin ok): pasa a publicada, loguea attempt 1 y avisa al creador', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })

    const avisos = []
    const fetchImpl = async (url, opts) => {
      if (url.includes('api.linkedin.com')) {
        return {
          ok: true, status: 201,
          headers: { get: (k) => (k.toLowerCase() === 'x-restli-id' ? 'urn:li:share:1' : null) },
          json: async () => ({}),
        }
      }
      if (url.includes('api.telegram.org')) {
        avisos.push(JSON.parse(opts.body))
        return { ok: true, json: async () => ({ ok: true }) }
      }
      throw new Error('fetch inesperado: ' + url)
    }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen).toEqual({ procesadas: 1, publicadas: 1, degradadas: 0, reintentos_pendientes: 0 })

    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('publicada')
    expect(row.published_url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1')

    const log = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ?').get(versionId)
    expect(log.attempt).toBe(1)
    expect(log.ok).toBe(1)

    expect(avisos).toHaveLength(1)
    expect(avisos[0].chat_id).toBe(ADMIN_CHAT)
    expect(avisos[0].text).toContain('✅ Publicado en linkedin')
    expect(avisos[0].text).toContain('urn:li:share:1')
  })

  it('fallo retryable (500) no cambia el status y deja log fallido con attempt 1', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })

    const fetchImpl = async (url) => {
      if (url.includes('api.linkedin.com')) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })

    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('programada')

    const log = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ?').get(versionId)
    expect(log.attempt).toBe(1)
    expect(log.ok).toBe(0)
  })

  it('backoff: no reintenta antes de 1 minuto desde el primer fallo (queda pendiente sin llamar fetch de publicación)', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })
    logAttemptAt(db, versionId, 1, false, "datetime('now')")

    let apiLlamada = false
    const fetchImpl = async (url) => {
      if (url.includes('api.linkedin.com')) apiLlamada = true
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resumen = await tick(db, { fetchImpl })

    expect(apiLlamada).toBe(false)
    expect(resumen).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })
    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('programada')
    // no se agregó ninguna fila nueva a publish_log (se saltea, no se intenta)
    const count = db.prepare('SELECT COUNT(*) AS n FROM publish_log WHERE channel_version_id = ?').get(versionId).n
    expect(count).toBe(1)
  })

  it('backoff cumplido (>=1 min desde el 1er fallo): reintenta como attempt 2', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })
    logAttemptAt(db, versionId, 1, false, "datetime('now', '-2 minutes')")

    const fetchImpl = async (url) => {
      if (url.includes('api.linkedin.com')) {
        return {
          ok: true, status: 201,
          headers: { get: (k) => (k.toLowerCase() === 'x-restli-id' ? 'urn:li:share:2' : null) },
          json: async () => ({}),
        }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen.publicadas).toBe(1)
    const log = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id DESC LIMIT 1').get(versionId)
    expect(log.attempt).toBe(2)
    expect(log.ok).toBe(1)
  })

  it('tercer fallo consecutivo degrada a entregada_manual: manda el paquete manual y avisa, sin reintentar la API', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })
    logAttemptAt(db, versionId, 1, false, "datetime('now', '-20 minutes')")
    logAttemptAt(db, versionId, 2, false, "datetime('now', '-15 minutes')")
    logAttemptAt(db, versionId, 3, false, "datetime('now', '-10 minutes')")

    const telegramCalls = []
    const fetchImpl = async (url, opts) => {
      if (url.includes('api.linkedin.com')) throw new Error('no debería reintentar la API tras 3 fallos')
      if (url.includes('api.telegram.org')) {
        telegramCalls.push({ url, text: JSON.parse(opts.body).text })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      throw new Error('fetch inesperado: ' + url)
    }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen).toEqual({ procesadas: 1, publicadas: 0, degradadas: 1, reintentos_pendientes: 0 })

    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('entregada_manual')

    // dos mensajes: el paquete manual (contiene el texto de la versión) y el aviso de degradación
    expect(telegramCalls).toHaveLength(2)
    expect(telegramCalls.some((c) => c.text.includes('Texto de prueba'))).toBe(true)
    expect(telegramCalls.some((c) => c.text.includes('⚠️') && c.text.includes('no respondió'))).toBe(true)

    const log = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id DESC LIMIT 1').get(versionId)
    expect(log.attempt).toBe(4)
    expect(log.ok).toBe(1)
  })

  it('instagram sin MEDIA_PUBLIC_BASE_URL degrada directo a manual desde el primer intento (sin reintentos)', async () => {
    delete process.env.MEDIA_PUBLIC_BASE_URL
    const { db } = makeTestApp()
    const testFile = join(tmpdir(), 'pbos-sched-ig-' + Date.now() + '.jpg')
    writeFileSync(testFile, Buffer.from('fake-jpeg'))

    const { versionId } = buildFixture(db, {
      channelCode: 'instagram',
      credentials: { access_token: 'tok', ig_user_id: '123' },
      mediaPath: testFile,
    })

    const telegramCalls = []
    const fetchImpl = async (url, opts) => {
      if (url.includes('graph.facebook.com')) throw new Error('no debería llamar a la API de instagram')
      if (url.includes('api.telegram.org')) {
        telegramCalls.push(url)
        return { ok: true, json: async () => ({ ok: true }) }
      }
      throw new Error('fetch inesperado: ' + url)
    }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen).toEqual({ procesadas: 1, publicadas: 0, degradadas: 1, reintentos_pendientes: 0 })

    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('entregada_manual')

    const log = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ?').get(versionId)
    expect(log.attempt).toBe(1)
    expect(log.ok).toBe(1)
    const responseJson = JSON.parse(log.response_json)
    expect(responseJson.motivo).toContain('MEDIA_PUBLIC_BASE_URL')

    unlinkSync(testFile)
  })

  it('versiones no programada (p.ej. aprobada) no se tocan aunque su scheduled_at esté vencido', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin', status: 'aprobada' })

    let fetchCalled = false
    const fetchImpl = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) } }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen).toEqual({ procesadas: 0, publicadas: 0, degradadas: 0, reintentos_pendientes: 0 })
    expect(fetchCalled).toBe(false)
    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('aprobada')
  })

  it('degradación con Telegram caído aplica backoff creciente, no reintenta cada minuto', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })

    let linkedinCalls = 0
    const fetchImpl = async (url) => {
      if (url.includes('api.linkedin.com')) {
        linkedinCalls++
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' }
      }
      if (url.includes('api.telegram.org')) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'telegram caído' }
      }
      throw new Error('fetch inesperado: ' + url)
    }

    // Attempt 1: intento real contra linkedin (falla, retryable). El canal
    // real se llama exactamente esta vez en todo el test.
    const r1 = await tick(db, { fetchImpl })
    expect(r1).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })
    expect(linkedinCalls).toBe(1)

    // Pre-sembramos los intentos 2 y 3 (fallidos) en el pasado para que el
    // próximo tick llegue con 3 intentos fallidos y degrade de inmediato.
    logAttemptAt(db, versionId, 2, false, "datetime('now', '-15 minutes')")
    logAttemptAt(db, versionId, 3, false, "datetime('now', '-10 minutes')")

    // Tick: degrada (attempt 4). El envío manual también falla (Telegram
    // caído), así que queda 'programada' pero YA marcada degrade_decidido.
    const r2 = await tick(db, { fetchImpl })
    expect(r2).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })
    expect(linkedinCalls).toBe(1) // no se volvió a llamar al canal real

    let row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('programada')

    let logs = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id').all(versionId)
    expect(logs).toHaveLength(4)
    expect(logs[3].attempt).toBe(4)
    expect(JSON.parse(logs[3].response_json).degrade_decidido).toBe(true)

    // Tick inmediatamente después (mismo minuto real): backoff de degradación
    // (1 min tras el primer intento de degradación) NO cumplido -> se saltea,
    // no llama a Telegram de nuevo, no agrega fila nueva.
    const r3 = await tick(db, { fetchImpl })
    expect(r3).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })
    expect(linkedinCalls).toBe(1)
    logs = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id').all(versionId)
    expect(logs).toHaveLength(4)

    // Simulamos que pasaron 15+ minutos desde el último intento de
    // degradación: ahora el backoff (con tope 15min) está sobradamente
    // cumplido y debe reintentar la entrega manual (attempt 5).
    db.prepare(`UPDATE publish_log SET created_at = datetime('now', '-16 minutes') WHERE id = ?`)
      .run(logs[3].id)

    const r4 = await tick(db, { fetchImpl })
    expect(r4).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })
    logs = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id').all(versionId)
    expect(logs).toHaveLength(5)
    expect(logs[4].attempt).toBe(5)
    expect(JSON.parse(logs[4].response_json).degrade_decidido).toBe(true)

    // A través de todo el test, el canal real (linkedin) se llamó como
    // mucho una vez: degrade_decidido evita volver a llamarlo.
    expect(linkedinCalls).toBe(1)
  })

  it('degradación llegado el piso de 15 minutos no reintenta antes de tiempo', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })

    const fetchImpl = async (url) => {
      if (url.includes('api.telegram.org')) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'telegram caído' }
      }
      throw new Error('fetch inesperado: ' + url)
    }

    // Sembramos directamente 3 intentos de degradación ya decididos (marcador
    // degrade_decidido), el último hace 10 minutos. Con intentosDegrade=3,
    // MINUTOS_BACKOFF no tiene entrada para 3 (solo 1 y 2), así que
    // backoffCumplido cae al tope TOPE_MINUTOS_BACKOFF_DEGRADE=15min.
    logDegradeAttemptAt(db, versionId, 1, "datetime('now', '-40 minutes')")
    logDegradeAttemptAt(db, versionId, 2, "datetime('now', '-25 minutes')")
    logDegradeAttemptAt(db, versionId, 3, "datetime('now', '-10 minutes')")

    // Con solo 10 minutos desde el último intento (< piso de 15min), el
    // backoff NO está cumplido: no debe reintentar la entrega manual todavía,
    // no debe agregar ninguna fila nueva a publish_log.
    const r1 = await tick(db, { fetchImpl })
    expect(r1).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })

    let logs = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id').all(versionId)
    expect(logs).toHaveLength(3) // el piso de 15min sigue vigente, no bajó a los 5min de intentosDegrade=2

    let row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('programada')

    // Movemos el último intento de degradación a 16 minutos atrás: ahora el
    // piso de 15min sí está cumplido y debe reintentar la entrega manual
    // (attempt 4, todavía marcado degrade_decidido).
    db.prepare(`UPDATE publish_log SET created_at = datetime('now', '-16 minutes') WHERE id = ?`)
      .run(logs[2].id)

    const r2 = await tick(db, { fetchImpl })
    expect(r2).toEqual({ procesadas: 1, publicadas: 0, degradadas: 0, reintentos_pendientes: 1 })

    logs = db.prepare('SELECT * FROM publish_log WHERE channel_version_id = ? ORDER BY id').all(versionId)
    expect(logs).toHaveLength(4)
    expect(logs[3].attempt).toBe(4)
    expect(JSON.parse(logs[3].response_json).degrade_decidido).toBe(true)

    row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('programada') // Telegram sigue caído: no se marca entregada_manual
  })

  it('una version que lanza no aborta el resto del lote', async () => {
    const { db } = makeTestApp()
    const bad = buildFixture(db, { channelCode: 'linkedin' })
    const good = buildFixture(db, { channelCode: 'linkedin' })

    // Forzamos que procesarVersion(bad) lance: borramos el draft que
    // referencia, dejando el channel_version con un draft_id colgante.
    // contextoDe() explota con TypeError al leer `draft.idea_id` de
    // `undefined` — exactamente el tipo de fila corrupta que no debe
    // abortar el resto del lote.
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM drafts WHERE id = ?').run(bad.draftId)
    db.pragma('foreign_keys = ON')

    const fetchImpl = async (url, opts) => {
      if (url.includes('api.linkedin.com')) {
        return {
          ok: true, status: 201,
          headers: { get: (k) => (k.toLowerCase() === 'x-restli-id' ? 'urn:li:share:ok' : null) },
          json: async () => ({}),
        }
      }
      if (url.includes('api.telegram.org')) return { ok: true, json: async () => ({ ok: true }) }
      throw new Error('fetch inesperado: ' + url)
    }

    const resumen = await tick(db, { fetchImpl })

    expect(resumen).toEqual({ procesadas: 2, publicadas: 1, degradadas: 0, reintentos_pendientes: 1 })

    const badRow = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(bad.versionId)
    expect(badRow.status).toBe('programada') // no se tocó, se reintentará el próximo tick

    const goodRow = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(good.versionId)
    expect(goodRow.status).toBe('publicada')
  })

  it('tick() concurrente se serializa, no publica dos veces', async () => {
    const { db } = makeTestApp()
    const { versionId } = buildFixture(db, { channelCode: 'linkedin' })

    let publishCalls = 0
    let releaseFn
    const release = new Promise((resolve) => { releaseFn = resolve })

    const fetchImpl = async (url) => {
      if (url.includes('api.linkedin.com')) {
        publishCalls++
        await release
        return {
          ok: true, status: 201,
          headers: { get: (k) => (k.toLowerCase() === 'x-restli-id' ? 'urn:li:share:concurrente' : null) },
          json: async () => ({}),
        }
      }
      if (url.includes('api.telegram.org')) return { ok: true, json: async () => ({ ok: true }) }
      throw new Error('fetch inesperado: ' + url)
    }

    // p1 arranca y queda colgado esperando `release` dentro del fetch de
    // linkedin -> el mutex tickEnProgreso ya quedó en true de forma
    // síncrona antes de que esta línea siguiente se ejecute.
    const p1 = tick(db, { fetchImpl })

    // p2 debe detectar el mutex tomado y volver de inmediato con saltado:true,
    // sin esperar a que se libere `release`.
    const r2 = await tick(db, { fetchImpl })
    expect(r2).toEqual({ procesadas: 0, publicadas: 0, degradadas: 0, reintentos_pendientes: 0, saltado: true })

    releaseFn()
    const r1 = await p1
    expect(r1).toEqual({ procesadas: 1, publicadas: 1, degradadas: 0, reintentos_pendientes: 0 })

    expect(publishCalls).toBe(1) // nunca se publicó dos veces
    const row = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
    expect(row.status).toBe('publicada')
  })
})

describe('scheduler: salud de tokens', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok-test'
    _resetHealthClock()
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
  })

  function buildCanalConVencimiento(db, expr) {
    const userId = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(ADMIN_CHAT).id
    const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(userId, profileId)
    const chId = db.prepare("SELECT id FROM channels WHERE code = 'linkedin'").get().id
    const pcId = db.prepare(
      "INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')"
    ).run(profileId, chId).lastInsertRowid
    db.prepare(`UPDATE profile_channels SET token_expires_at = ${expr} WHERE id = ?`).run(pcId)
    return { userId, profileId, pcId }
  }

  it('token que vence en 3 días avisa a los owners; no se repite en el mismo día; sí tras _resetHealthClock', async () => {
    const { db } = makeTestApp()
    buildCanalConVencimiento(db, "datetime('now', '+3 days')")

    const avisos = []
    const fetchImpl = async (url, opts) => {
      avisos.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ ok: true }) }
    }

    await tokenHealthMaybe(db, { fetchImpl })
    expect(avisos).toHaveLength(1)
    expect(avisos[0].chat_id).toBe(ADMIN_CHAT)
    expect(avisos[0].text).toContain('🔑')
    expect(avisos[0].text).toContain('linkedin')
    expect(avisos[0].text).toContain('JP')
    expect(avisos[0].text).toContain('Reconectalo')

    // segunda corrida el mismo "día": no repite (reloj en memoria)
    await tokenHealthMaybe(db, { fetchImpl })
    expect(avisos).toHaveLength(1)

    // forzamos el reloj: vuelve a avisar
    _resetHealthClock()
    await tokenHealthMaybe(db, { fetchImpl })
    expect(avisos).toHaveLength(2)
  })

  it('token que vence en más de 7 días no dispara aviso', async () => {
    const { db } = makeTestApp()
    buildCanalConVencimiento(db, "datetime('now', '+30 days')")

    let called = false
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ ok: true }) } }

    await tokenHealthMaybe(db, { fetchImpl })
    expect(called).toBe(false)
  })

  it('tick() dispara tokenHealthMaybe automáticamente', async () => {
    const { db } = makeTestApp()
    buildCanalConVencimiento(db, "datetime('now', '+1 days')")

    const avisos = []
    const fetchImpl = async (url, opts) => {
      avisos.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ ok: true }) }
    }

    await tick(db, { fetchImpl })
    expect(avisos.some((a) => a.text.includes('🔑'))).toBe(true)
  })
})
