import { decryptJson } from '../crypto.js'
import { publicarManual } from './manual.js'
import { publicarLinkedin } from './linkedin.js'
import { publicarInstagram } from './instagram.js'

/** Registry de módulos publicadores por `channels.publisher_module`. */
const registry = {
  manual: publicarManual,
  linkedin: publicarLinkedin,
  instagram: publicarInstagram,
}

function esDryRun(deps) {
  if (deps && deps.dryRun) return true
  return process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
}

function resolverModulo(db, versionRow) {
  const row = db.prepare(`
    SELECT c.publisher_module AS publisher_module
    FROM profile_channels pc
    JOIN channels c ON c.id = pc.channel_id
    WHERE pc.id = ?
  `).get(versionRow.profile_channel_id)
  return row ? row.publisher_module : null
}

/**
 * Arma todo el contexto que un módulo publicador necesita para publicar
 * una channel_version: la fila, el draft, la idea, el perfil, el código de
 * canal, las credenciales descifradas (o null) y el chat de Telegram del
 * creador de la idea.
 * @param {import('better-sqlite3').Database} db
 * @param {number} versionId
 * @returns {{version:object, draft:object, idea:object, profile:object, channelCode:string|null, credentials:object|null, creatorChatId:string|null} | null}
 */
export function contextoDe(db, versionId) {
  const version = db.prepare('SELECT * FROM channel_versions WHERE id = ?').get(versionId)
  if (!version) return null

  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(version.draft_id)
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(draft.idea_id)
  const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(draft.profile_id)

  const pc = db.prepare(`
    SELECT pc.*, c.code AS channel_code
    FROM profile_channels pc
    JOIN channels c ON c.id = pc.channel_id
    WHERE pc.id = ?
  `).get(version.profile_channel_id)
  const channelCode = pc ? pc.channel_code : null

  let credentials = null
  if (pc && pc.credentials_enc) {
    try {
      credentials = decryptJson(pc.credentials_enc)
    } catch {
      credentials = null
    }
  }

  const creator = db.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').get(idea.created_by)
  const creatorChatId = creator ? creator.telegram_chat_id : null

  return { version, draft, idea, profile, channelCode, credentials, creatorChatId }
}

/**
 * Contrato del publicador (spec Plan D §Global Constraints):
 * publicar(db, version, deps) → { ok: true, url? } | { ok: true, manual: true } | { ok: false, retryable: true, error }
 * Jamás lanza — todo error se captura y clasifica.
 * @param {import('better-sqlite3').Database} db
 * @param {object} versionRow - fila de channel_versions (al menos {id, profile_channel_id})
 * @param {{fetchImpl?: Function, dryRun?: boolean}} deps
 */
export async function publicar(db, versionRow, deps = {}) {
  if (esDryRun(deps)) {
    return { ok: true, url: 'dry-run' }
  }

  const moduleName = resolverModulo(db, versionRow)
  const fn = moduleName && registry[moduleName] ? registry[moduleName] : publicarManual

  try {
    const ctx = contextoDe(db, versionRow.id)
    return await fn(ctx, deps)
  } catch (err) {
    return { ok: false, retryable: true, error: String(err) }
  }
}
