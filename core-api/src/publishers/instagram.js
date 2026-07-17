import { basename, relative, sep } from 'node:path'

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
 * Construye la URL pública de la imagen a partir de media_path, preservando
 * la subcarpeta (p. ej. "versions/") en la que se guardó el archivo dentro
 * de MEDIA_DIR. Si media_path no cuelga de MEDIA_DIR (o no se puede resolver
 * una ruta relativa razonable), cae de vuelta a usar solo el basename en vez
 * de romper la publicación.
 */
function buildImageUrl(mediaBaseUrl, mediaPath) {
  const mediaDir = process.env.MEDIA_DIR || '/data/media'
  const rel = relative(mediaDir, mediaPath)
  if (!rel || rel.startsWith('..')) {
    return `${mediaBaseUrl}/${basename(mediaPath)}`
  }
  return `${mediaBaseUrl}/${rel.split(sep).join('/')}`
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
  const imageUrl = buildImageUrl(mediaBaseUrl, version.media_path)

  try {
    const mediaParams = new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: accessToken,
    })
    const mediaRes = await fetchImpl(`${BASE}/${igUserId}/media`, {
      method: 'POST',
      body: mediaParams,
      signal: AbortSignal.timeout(30000),
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
      signal: AbortSignal.timeout(30000),
    })
    const publishBody = await leerJson(publishRes)
    if (!publishRes.ok) return clasificarError(publishRes.status, publishBody)
    const mediaId = publishBody.id

    let url = FALLBACK_URL
    try {
      const permalinkRes = await fetchImpl(
        `${BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`,
        { signal: AbortSignal.timeout(30000) }
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
