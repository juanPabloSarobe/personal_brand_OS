import { readFileSync } from 'node:fs'

const BASE = 'https://api.linkedin.com/v2'

function armarTexto(version) {
  let texto = version.text_content || ''
  if (version.hashtags) texto += `\n\n${version.hashtags}`
  return texto
}

function extraerId(res, body) {
  const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-restli-id') : null
  return header || (body && body.id) || null
}

function clasificarError(status) {
  if (status === 401 || status === 403) {
    return { ok: false, retryable: false, degrade: true, reason: 'token inválido o vencido' }
  }
  return { ok: false, retryable: true, error: `HTTP ${status}` }
}

async function ugcPost({ fetchImpl, accessToken, personUrn, texto, media }) {
  const shareContent = {
    shareCommentary: { text: texto },
    shareMediaCategory: media ? 'IMAGE' : 'NONE',
  }
  if (media) {
    shareContent.media = [{ status: 'READY', media }]
  }

  const body = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': shareContent,
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  }

  const res = await fetchImpl(`${BASE}/ugcPosts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) return clasificarError(res.status)

  let jsonBody = {}
  try {
    jsonBody = await res.json()
  } catch {
    jsonBody = {}
  }
  const id = extraerId(res, jsonBody)
  return { ok: true, url: `https://www.linkedin.com/feed/update/${id}` }
}

async function registrarYSubirImagen({ fetchImpl, accessToken, personUrn, mediaPath }) {
  const registerBody = {
    registerUploadRequest: {
      recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
      owner: personUrn,
      serviceRelationships: [
        { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
      ],
    },
  }

  const registerRes = await fetchImpl(`${BASE}/assets?action=registerUpload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(registerBody),
    signal: AbortSignal.timeout(30000),
  })

  if (!registerRes.ok) return { error: clasificarError(registerRes.status) }

  const registerJson = await registerRes.json()
  const uploadUrl = registerJson.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl
  const asset = registerJson.value.asset

  const fileBuffer = readFileSync(mediaPath)
  const putRes = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: fileBuffer,
    signal: AbortSignal.timeout(30000),
  })

  if (!putRes.ok) return { error: clasificarError(putRes.status) }

  return { asset }
}

/**
 * Publicador LinkedIn (spec Plan D §Global Constraints / Task 4).
 * @param {{version: object, credentials: object|null}} ctx
 * @param {{fetchImpl?: Function}} deps
 * @returns {Promise<{ok:true, url:string} | {ok:false, retryable:boolean, error?:string, degrade?:true, reason?:string}>}
 */
export async function publicarLinkedin(ctx, deps = {}) {
  const { version, credentials } = ctx
  if (!credentials || !credentials.access_token || !credentials.person_urn) {
    return { ok: false, retryable: false, degrade: true, reason: 'sin credenciales linkedin' }
  }

  const fetchImpl = deps.fetchImpl || fetch
  const { access_token: accessToken, person_urn: personUrn } = credentials
  const texto = armarTexto(version)

  try {
    let asset = null
    if (version.media_path) {
      const subida = await registrarYSubirImagen({ fetchImpl, accessToken, personUrn, mediaPath: version.media_path })
      if (subida.error) return subida.error
      asset = subida.asset
    }

    return await ugcPost({ fetchImpl, accessToken, personUrn, texto, media: asset })
  } catch (err) {
    return { ok: false, retryable: true, error: String(err) }
  }
}
