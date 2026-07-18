import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestApp, ADMIN_CHAT } from './helpers.js'
import { createIdea, linkIdeaProfiles, createDraft, createChannelVersion } from '../src/services/editorial.js'
import { encryptJson } from '../src/crypto.js'
import { publicar } from '../src/publishers/index.js'

/** Construye la cadena idea -> draft -> profile_channel -> channel_version. */
function buildFixture(db, { channelCode = 'wa_status', mediaPath = null, credentials = null, hashtags = '#test' } = {}) {
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id = ?").get(ADMIN_CHAT).id
  const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
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
    mediaPath, hashtags, status: 'programada',
  })

  const versionRow = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
  return { userId, profileId, pcId, ideaId, draftId, versionId, versionRow }
}

describe('publicadores: contrato + registry + manual', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok-test'
  })

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.DRY_RUN
  })

  it('dry run no llama módulos: DRY_RUN devuelve {ok:true, url:dry-run} sin invocar fetch', async () => {
    const { db } = makeTestApp()
    const { versionRow } = buildFixture(db, { channelCode: 'wa_status' })

    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, json: async () => ({ ok: true }) }
    }

    process.env.DRY_RUN = '1'
    const resultado = await publicar(db, versionRow, { fetchImpl })

    expect(resultado).toEqual({ ok: true, url: 'dry-run' })
    expect(fetchCalled).toBe(false)
  })

  it('deps.dryRun también evita tocar módulos', async () => {
    const { db } = makeTestApp()
    const { versionRow } = buildFixture(db, { channelCode: 'wa_status' })

    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resultado = await publicar(db, versionRow, { fetchImpl, dryRun: true })

    expect(resultado).toEqual({ ok: true, url: 'dry-run' })
    expect(fetchCalled).toBe(false)
  })

  it('canal wa_status con media_path publica manual vía sendPhoto con la instrucción de WhatsApp', async () => {
    const { db } = makeTestApp()
    const testFile = join(tmpdir(), 'pbos-manual-' + Date.now() + '.jpg')
    writeFileSync(testFile, Buffer.from('fake-jpeg'))

    const { versionRow } = buildFixture(db, { channelCode: 'wa_status', mediaPath: testFile })

    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resultado = await publicar(db, versionRow, { fetchImpl })

    expect(resultado).toEqual({ ok: true, manual: true })
    expect(captured.url).toBe('https://api.telegram.org/bottok-test/sendPhoto')
    const captionEntry = Array.from(captured.opts.body.entries()).find(([name]) => name === 'caption')
    expect(captionEntry[1]).toContain('Texto de prueba')
    expect(captionEntry[1]).toContain('#test')
    expect(captionEntry[1]).toContain('Subilo a tu estado de WhatsApp 👆')

    unlinkSync(testFile)
  })

  it('sin media_path publica manual vía sendMessage con instrucción por defecto', async () => {
    const { db } = makeTestApp()
    const { versionRow } = buildFixture(db, { channelCode: 'wa_status', mediaPath: null })

    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resultado = await publicar(db, versionRow, { fetchImpl })

    expect(resultado).toEqual({ ok: true, manual: true })
    expect(captured.url).toBe('https://api.telegram.org/bottok-test/sendMessage')
    const body = JSON.parse(captured.opts.body)
    expect(body.text).toContain('Texto de prueba')
    expect(body.text).toContain('#test')
    expect(body.text).toContain('Subilo a tu estado de WhatsApp 👆')
  })

  it('telegram caído (HTTP 500) → {ok:false, retryable:true, error}', async () => {
    const { db } = makeTestApp()
    const { versionRow } = buildFixture(db, { channelCode: 'wa_status', mediaPath: null })

    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' })

    const resultado = await publicar(db, versionRow, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
    expect(resultado.error).toBeDefined()
    expect(resultado.error).not.toContain('tok-test')
  })

  it('módulo desconocido (channels.publisher_module NULL) cae a manual', async () => {
    const { db } = makeTestApp()
    // 'x' (Twitter) está planificado en el catálogo con publisher_module NULL
    const { versionRow } = buildFixture(db, { channelCode: 'x', mediaPath: null })

    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, json: async () => ({ ok: true }) }
    }

    const resultado = await publicar(db, versionRow, { fetchImpl })

    expect(resultado).toEqual({ ok: true, manual: true })
    expect(captured.url).toBe('https://api.telegram.org/bottok-test/sendMessage')
    const body = JSON.parse(captured.opts.body)
    expect(body.text).toContain('Listo para pegar en x 👆')
  })
})
