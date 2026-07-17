import { basename } from 'node:path'

const BASE = 'https://graph.facebook.com/v21.0'
const FALLBACK_URL = 'https://www.instagram.com/'

function armarCaption(version) {
  let texto = version.text_content || ''
  if (version.hashtags) texto += `\n\n${version.hashtags}`
  return texto
}

async function leerJson(res) {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

function esErrorToken(status, body) {
  if (status === 401 || status === 403) return true
  const code = body && body.error && body.error.code
  return code === 190
}

function clasificarError(status, body) {
  if (esErrorToken(status, body)) {
    return { ok: false, retryable: false, degrade: true, reason: 'token inválido o vencido' }
  }
  return { ok: false, retryable: true, error: `HTTP ${status}` }
}

/**
 * Publicador Instagram (spec Plan D §Global Constraints / Task 5).
 * Requiere URL pública de la imagen (env MEDIA_PUBLIC_BASE_URL); sin ella
 * degrada honestamente a paquete manual (la API de IG no acepta binario
 * directo para fotos de feed).
 * @param {{version: object, credentials: object|null}} ctx
 * @param {{fetchImpl?: Function}} deps
 * @returns {Promise<{ok:true, url:string} | {ok:false, retryable:boolean, error?:string, degrade?:true, reason?:string}>}
 */
export async function publicarInstagram(ctx, deps = {}) {
  const { version, credentials } = ctx

  if (!credentials || !credentials.access_token || !credentials.ig_user_id) {
    return { ok: false, retryable: false, degrade: true, reason: 'sin credenciales instagram' }
  }
  if (!version.media_path) {
    return { ok: false, retryable: false, degrade: true, reason: 'instagram requiere imagen' }
  }
  const mediaBaseUrl = process.env.MEDIA_PUBLIC_BASE_URL
  if (!mediaBaseUrl) {
    return { ok: false, retryable: false, degrade: true, reason: 'sin MEDIA_PUBLIC_BASE_URL (paquete manual)' }
  }

  const fetchImpl = deps.fetchImpl || fetch
  const { access_token: accessToken, ig_user_id: igUserId } = credentials
  const caption = armarCaption(version)
  const imageUrl = `${mediaBaseUrl}/${basename(version.media_path)}`

  try {
    const mediaParams = new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: accessToken,
    })
    const mediaRes = await fetchImpl(`${BASE}/${igUserId}/media`, {
      method: 'POST',
      body: mediaParams,
    })
    const mediaBody = await leerJson(mediaRes)
    if (!mediaRes.ok) return clasificarError(mediaRes.status, mediaBody)
    const creationId = mediaBody.id

    const publishParams = new URLSearchParams({
      creation_id: creationId,
      access_token: accessToken,
    })
    const publishRes = await fetchImpl(`${BASE}/${igUserId}/media_publish`, {
      method: 'POST',
      body: publishParams,
    })
    const publishBody = await leerJson(publishRes)
    if (!publishRes.ok) return clasificarError(publishRes.status, publishBody)
    const mediaId = publishBody.id

    let url = FALLBACK_URL
    try {
      const permalinkRes = await fetchImpl(
        `${BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`
      )
      if (permalinkRes.ok) {
        const permalinkBody = await leerJson(permalinkRes)
        if (permalinkBody.permalink) url = permalinkBody.permalink
      }
    } catch {
      // GET del permalink falló: nos quedamos con el fallback sin romper.
    }

    return { ok: true, url }
  } catch (err) {
    return { ok: false, retryable: true, error: String(err) }
  }
}
