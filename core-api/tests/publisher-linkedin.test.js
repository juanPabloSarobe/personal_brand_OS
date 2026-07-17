import { describe, it, expect } from 'vitest'
import { publicarLinkedin } from '../src/publishers/linkedin.js'

/** Construye un contexto mínimo tal como lo arma contextoDe() para el módulo linkedin. */
function buildCtx({ credentials = { access_token: 'secret-tok-123', person_urn: 'urn:li:person:abc' }, mediaPath = null, hashtags = '#test' } = {}) {
  return {
    version: {
      id: 1,
      text_content: 'Texto de prueba',
      hashtags,
      media_path: mediaPath,
    },
    channelCode: 'linkedin',
    credentials,
  }
}

describe('publicador linkedin', () => {
  it('sin credenciales → degrade sin llamar fetch', async () => {
    const ctx = buildCtx({ credentials: null })
    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, headers: { get: () => null }, json: async () => ({}) }
    }

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'sin credenciales linkedin' })
    expect(fetchCalled).toBe(false)
  })

  it('texto solo: ugcPost NONE con author URN, header Restli y shareCommentary = texto+hashtags; url del id', async () => {
    const ctx = buildCtx({ mediaPath: null })
    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return {
        ok: true,
        status: 201,
        headers: { get: (k) => (k.toLowerCase() === 'x-restli-id' ? 'urn:li:share:999' : null) },
        json: async () => ({}),
      }
    }

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(captured.url).toBe('https://api.linkedin.com/v2/ugcPosts')
    expect(captured.opts.method).toBe('POST')
    expect(captured.opts.headers['Authorization']).toBe('Bearer secret-tok-123')
    expect(captured.opts.headers['X-Restli-Protocol-Version']).toBe('2.0.0')

    const body = JSON.parse(captured.opts.body)
    expect(body.author).toBe('urn:li:person:abc')
    expect(body.lifecycleState).toBe('PUBLISHED')
    expect(body.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text).toBe('Texto de prueba\n\n#test')
    expect(body.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory).toBe('NONE')
    expect(body.visibility['com.linkedin.ugc.MemberNetworkVisibility']).toBe('PUBLIC')

    expect(resultado).toEqual({ ok: true, url: 'https://www.linkedin.com/feed/update/urn:li:share:999' })
  })

  it('texto sin hashtags no agrega el separador', async () => {
    const ctx = buildCtx({ mediaPath: null, hashtags: null })
    let captured
    const fetchImpl = async (url, opts) => {
      captured = { url, opts }
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ id: 'urn:li:share:111' }) }
    }

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    const body = JSON.parse(captured.opts.body)
    expect(body.specificContent['com.linkedin.ugc.ShareContent'].shareCommentary.text).toBe('Texto de prueba')
    expect(resultado.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:111')
  })

  it('con imagen: 3 llamadas en orden (registerUpload, PUT binario, ugcPost IMAGE con asset)', async () => {
    const ctx = buildCtx({ mediaPath: '/tmp/no-existe-pero-mockeado.jpg' })
    const llamadas = []

    // Mockeamos readFileSync indirectamente: el módulo debe leer el archivo real.
    // Usamos un archivo real temporal para que readFileSync funcione.
    const { writeFileSync, unlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const testFile = join(tmpdir(), 'pbos-linkedin-' + Date.now() + '.jpg')
    writeFileSync(testFile, Buffer.from('fake-image-bytes'))
    ctx.version.media_path = testFile

    const fetchImpl = async (url, opts) => {
      llamadas.push({ url, opts })
      if (url.includes('registerUpload')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            value: {
              uploadMechanism: {
                'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': {
                  uploadUrl: 'https://upload.linkedin.com/put-aqui',
                },
              },
              asset: 'urn:li:digitalmediaAsset:xyz',
            },
          }),
        }
      }
      if (url === 'https://upload.linkedin.com/put-aqui') {
        return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({}) }
      }
      // ugcPost final
      return {
        ok: true,
        status: 201,
        headers: { get: (k) => (k.toLowerCase() === 'x-restli-id' ? 'urn:li:share:image1' : null) },
        json: async () => ({}),
      }
    }

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(llamadas).toHaveLength(3)

    // 1) registerUpload
    expect(llamadas[0].url).toBe('https://api.linkedin.com/v2/assets?action=registerUpload')
    const registerBody = JSON.parse(llamadas[0].opts.body)
    expect(registerBody.registerUploadRequest.recipes).toEqual(['urn:li:digitalmediaRecipe:feedshare-image'])
    expect(registerBody.registerUploadRequest.owner).toBe('urn:li:person:abc')
    expect(registerBody.registerUploadRequest.serviceRelationships).toEqual([
      { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
    ])
    expect(llamadas[0].opts.headers['Authorization']).toBe('Bearer secret-tok-123')

    // 2) PUT binario
    expect(llamadas[1].url).toBe('https://upload.linkedin.com/put-aqui')
    expect(llamadas[1].opts.method).toBe('PUT')
    expect(llamadas[1].opts.headers['Authorization']).toBe('Bearer secret-tok-123')
    expect(Buffer.isBuffer(llamadas[1].opts.body) || llamadas[1].opts.body instanceof Uint8Array).toBe(true)

    // 3) ugcPost con media asset
    expect(llamadas[2].url).toBe('https://api.linkedin.com/v2/ugcPosts')
    const postBody = JSON.parse(llamadas[2].opts.body)
    expect(postBody.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory).toBe('IMAGE')
    expect(postBody.specificContent['com.linkedin.ugc.ShareContent'].media).toEqual([
      { status: 'READY', media: 'urn:li:digitalmediaAsset:xyz' },
    ])

    expect(resultado).toEqual({ ok: true, url: 'https://www.linkedin.com/feed/update/urn:li:share:image1' })

    unlinkSync(testFile)
  })

  it('401 → {ok:false, retryable:false, degrade:true, reason} sin exponer el token', async () => {
    const ctx = buildCtx({ mediaPath: null })
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => 'Unauthorized',
      json: async () => ({ message: 'Unauthorized' }),
    })

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(false)
    expect(resultado.degrade).toBe(true)
    expect(resultado.reason).toBe('token inválido o vencido')
    expect(JSON.stringify(resultado)).not.toContain('secret-tok-123')
  })

  it('403 → degrade también', async () => {
    const ctx = buildCtx({ mediaPath: null })
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => 'Forbidden',
      json: async () => ({}),
    })

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'token inválido o vencido' })
  })

  it('500 → {ok:false, retryable:true} sin exponer el token', async () => {
    const ctx = buildCtx({ mediaPath: null })
    const fetchImpl = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => 'Internal Server Error',
    })

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
    expect(JSON.stringify(resultado)).not.toContain('secret-tok-123')
  })

  it('429 → retryable:true', async () => {
    const ctx = buildCtx({ mediaPath: null })
    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => 'Too Many Requests',
    })

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
  })

  it('excepción de red (fetch lanza) no propaga: retryable:true', async () => {
    const ctx = buildCtx({ mediaPath: null })
    const fetchImpl = async () => {
      throw new Error('network down')
    }

    const resultado = await publicarLinkedin(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
  })
})
