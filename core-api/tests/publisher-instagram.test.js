import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { publicarInstagram } from '../src/publishers/instagram.js'

/** Construye un contexto mínimo tal como lo arma contextoDe() para el módulo instagram. */
function buildCtx({
  credentials = { access_token: 'secret-tok-ig-123', ig_user_id: '17841400000000000' },
  mediaPath = '/data/media/foto-123.jpg',
  hashtags = '#test',
} = {}) {
  return {
    version: {
      id: 1,
      text_content: 'Texto de prueba',
      hashtags,
      media_path: mediaPath,
    },
    channelCode: 'instagram',
    credentials,
  }
}

const ORIGINAL_BASE_URL = process.env.MEDIA_PUBLIC_BASE_URL

describe('publicador instagram', () => {
  beforeEach(() => {
    delete process.env.MEDIA_PUBLIC_BASE_URL
  })

  afterEach(() => {
    if (ORIGINAL_BASE_URL === undefined) delete process.env.MEDIA_PUBLIC_BASE_URL
    else process.env.MEDIA_PUBLIC_BASE_URL = ORIGINAL_BASE_URL
  })

  it('sin credenciales → degrade sin llamar fetch', async () => {
    const ctx = buildCtx({ credentials: null })
    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, json: async () => ({}) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'sin credenciales instagram' })
    expect(fetchCalled).toBe(false)
  })

  it('sin media_path → degrade "instagram requiere imagen" sin llamar fetch', async () => {
    const ctx = buildCtx({ mediaPath: null })
    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, json: async () => ({}) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'instagram requiere imagen' })
    expect(fetchCalled).toBe(false)
  })

  it('sin MEDIA_PUBLIC_BASE_URL → degrade "sin MEDIA_PUBLIC_BASE_URL (paquete manual)" sin llamar fetch', async () => {
    const ctx = buildCtx()
    let fetchCalled = false
    const fetchImpl = async () => {
      fetchCalled = true
      return { ok: true, json: async () => ({}) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'sin MEDIA_PUBLIC_BASE_URL (paquete manual)' })
    expect(fetchCalled).toBe(false)
  })

  it('flujo completo: 3 llamadas en orden con params correctos → url = permalink', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const llamadas = []

    const fetchImpl = async (url, opts) => {
      llamadas.push({ url, opts })
      if (llamadas.length === 1) {
        // POST .../media
        return { ok: true, status: 200, json: async () => ({ id: 'creation-id-999' }) }
      }
      if (llamadas.length === 2) {
        // POST .../media_publish
        return { ok: true, status: 200, json: async () => ({ id: 'media-id-888' }) }
      }
      // GET .../{media_id}?fields=permalink
      return { ok: true, status: 200, json: async () => ({ permalink: 'https://www.instagram.com/p/ABC123/' }) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(llamadas).toHaveLength(3)

    // 1) crear contenedor
    expect(llamadas[0].url).toBe('https://graph.facebook.com/v21.0/17841400000000000/media')
    expect(llamadas[0].opts.method).toBe('POST')
    const mediaParams = new URLSearchParams(llamadas[0].opts.body)
    expect(mediaParams.get('image_url')).toBe('https://media.example.com/data/media/foto-123.jpg')
    expect(mediaParams.get('caption')).toBe('Texto de prueba\n\n#test')
    expect(mediaParams.get('access_token')).toBe('secret-tok-ig-123')

    // 2) publicar
    expect(llamadas[1].url).toBe('https://graph.facebook.com/v21.0/17841400000000000/media_publish')
    expect(llamadas[1].opts.method).toBe('POST')
    const publishParams = new URLSearchParams(llamadas[1].opts.body)
    expect(publishParams.get('creation_id')).toBe('creation-id-999')
    expect(publishParams.get('access_token')).toBe('secret-tok-ig-123')

    // 3) permalink
    expect(llamadas[2].url).toContain('https://graph.facebook.com/v21.0/media-id-888?fields=permalink')
    expect(llamadas[2].url).toContain('access_token=secret-tok-ig-123')

    expect(resultado).toEqual({ ok: true, url: 'https://www.instagram.com/p/ABC123/' })
  })

  it('caption incluye hashtags; sin hashtags no agrega separador', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx({ hashtags: null })
    let captionCapturada
    const fetchImpl = async (url, opts) => {
      if (url.endsWith('/media')) {
        captionCapturada = new URLSearchParams(opts.body).get('caption')
        return { ok: true, status: 200, json: async () => ({ id: 'creation-id-1' }) }
      }
      if (url.endsWith('/media_publish')) {
        return { ok: true, status: 200, json: async () => ({ id: 'media-id-1' }) }
      }
      return { ok: true, status: 200, json: async () => ({ permalink: 'https://www.instagram.com/p/XYZ/' }) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(captionCapturada).toBe('Texto de prueba')
    expect(resultado.ok).toBe(true)
  })

  it('GET del permalink falla → url fallback "https://www.instagram.com/" sin romper', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const fetchImpl = async (url) => {
      if (url.endsWith('/media')) return { ok: true, status: 200, json: async () => ({ id: 'creation-id-1' }) }
      if (url.endsWith('/media_publish')) return { ok: true, status: 200, json: async () => ({ id: 'media-id-1' }) }
      return { ok: false, status: 500, json: async () => ({}) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: true, url: 'https://www.instagram.com/' })
  })

  it('401 en la creación del contenedor → degrade "token inválido o vencido" sin exponer el token', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid OAuth access token', code: 190 } }),
    })

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'token inválido o vencido' })
    expect(JSON.stringify(resultado)).not.toContain('secret-tok-ig-123')
  })

  it('código de error 190 en el body (sin 401/403) → degrade también', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'token expirado', code: 190 } }),
    })

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado).toEqual({ ok: false, retryable: false, degrade: true, reason: 'token inválido o vencido' })
  })

  it('500 en media_publish → retryable:true', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const fetchImpl = async (url) => {
      if (url.endsWith('/media')) return { ok: true, status: 200, json: async () => ({ id: 'creation-id-1' }) }
      return { ok: false, status: 500, json: async () => ({}) }
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
  })

  it('429 → retryable:true', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({}) })

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
  })

  it('excepción de red (fetch lanza) no propaga: retryable:true', async () => {
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com/data/media'
    const ctx = buildCtx()
    const fetchImpl = async () => {
      throw new Error('network down')
    }

    const resultado = await publicarInstagram(ctx, { fetchImpl })

    expect(resultado.ok).toBe(false)
    expect(resultado.retryable).toBe(true)
  })
})
