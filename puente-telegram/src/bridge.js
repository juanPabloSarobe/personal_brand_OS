import { mapUpdate } from './mapper.js'

const api = (token) => `https://api.telegram.org/bot${token}`
const files = (token) => `https://api.telegram.org/file/bot${token}`

export function config(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN
  const webhook = env.N8N_WEBHOOK_URL
  if (!token || !webhook) throw new Error('faltan TELEGRAM_BOT_TOKEN o N8N_WEBHOOK_URL')
  return { token, webhook }
}

export async function fetchUpdates(offset, { token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${api(token)}/getUpdates?timeout=25&offset=${offset}`)
  if (!res.ok) throw new Error(`getUpdates respondió ${res.status}`)
  const data = await res.json()
  if (!data.ok) throw new Error('getUpdates devolvió ok=false')
  return data.result
}

export async function downloadFile(fileId, { token, fetchImpl = fetch }) {
  const meta = await fetchImpl(`${api(token)}/getFile?file_id=${fileId}`)
  if (!meta.ok) throw new Error(`getFile respondió ${meta.status}`)
  const info = await meta.json()
  const bin = await fetchImpl(`${files(token)}/${info.result.file_path}`)
  if (!bin.ok) throw new Error(`descarga de archivo respondió ${bin.status}`)
  return Buffer.from(await bin.arrayBuffer())
}

export async function forwardUpdate(update, deps) {
  const { token, webhook, fetchImpl = fetch } = deps
  const mapped = mapUpdate(update)
  if (!mapped) return { forwarded: false, reason: 'sin_mapeo' }
  const payload = { ...mapped }
  if (mapped.fileId) {
    const buffer = await downloadFile(mapped.fileId, deps)
    payload.content_base64 = buffer.toString('base64')
    delete payload.fileId
  }
  if (mapped.callbackQueryId) {
    try {
      await fetchImpl(`${api(token)}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: mapped.callbackQueryId }),
      })
    } catch {}
    delete payload.callbackQueryId
  }
  const res = await fetchImpl(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`webhook respondió ${res.status}`)
  return { forwarded: true }
}

export async function runOnce(offset, deps) {
  const log = deps.log || console
  // default a fetch real: en producción deps no trae fetchImpl
  const fetchImpl = deps.fetchImpl || fetch
  const updates = await fetchUpdates(offset, deps)
  let next = offset
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1)
    try {
      await forwardUpdate(u, deps)
    } catch (err) {
      log.error(`puente: update ${u.update_id} falló: ${err}`)
      const mapped = mapUpdate(u)
      if (mapped) {
        try {
          await fetchImpl(`${api(deps.token)}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: mapped.chatId, text: '⚠️ No pude procesar ese mensaje. Probá de nuevo en un rato.' }),
          })
        } catch {}
      }
    }
  }
  return next
}
