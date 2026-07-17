import { describe, it, expect } from 'vitest'
import { runCodeNode } from './n8n-harness.js'

describe('nodo 01: preparar evidencia', () => {
  it('comando → ayuda', () => {
    const [out] = runCodeNode('01-preparar-evidencia.js', {
      json: { body: { chatId: '9', tipo: 'comando', comando: '/start', texto: '/start' } },
    })
    expect(out.json.esComando).toBe(true)
    expect(out.json.chatId).toBe('9')
    expect(out.json.texto).toMatch(/Personal Brand OS/)
  })

  it('audio → evidencePost completo', () => {
    const [out] = runCodeNode('01-preparar-evidencia.js', {
      json: { body: { chatId: '9', tipo: 'audio', filename: 'nota-de-voz.ogg', content_base64: 'QUJD', caption: 'en obra' } },
    })
    expect(out.json.esComando).toBe(false)
    expect(out.json.evidencePost).toEqual({
      type: 'audio',
      text: null,
      filename: 'nota-de-voz.ogg',
      content_base64: 'QUJD',
      context: { origen: 'telegram', caption: 'en obra' },
    })
  })

  it('texto → evidencePost con text', () => {
    const [out] = runCodeNode('01-preparar-evidencia.js', {
      json: { body: { chatId: '9', tipo: 'texto', texto: 'probamos el sensor' } },
    })
    expect(out.json.evidencePost.type).toBe('texto')
    expect(out.json.evidencePost.text).toBe('probamos el sensor')
  })
})

describe('nodo 02: armar respuesta', () => {
  const nodes = { 'Preparar evidencia': { chatId: '9' } }

  it('201 con detalle → eco completo', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: {
        statusCode: 201,
        body: {
          folio: 'E-0042', processed: true,
          detalle: {
            transcription: 'probamos SkyTrace',
            vision_description: null,
            entities: [{ kind: 'empresa', name: 'SkyTrace' }],
          },
        },
      },
      nodes,
    })
    expect(out.json.responder).toBe(true)
    expect(out.json.texto).toContain('E-0042')
    expect(out.json.texto).toContain('probamos SkyTrace')
    expect(out.json.texto).toContain('SkyTrace')
  })

  it('403 → silencio administrativo', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', { json: { statusCode: 403, body: {} }, nodes })
    expect(out.json.responder).toBe(false)
  })

  it('error de la API → fallback amable que no pierde la captura', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', { json: { error: 'ECONNREFUSED' }, nodes })
    expect(out.json.responder).toBe(true)
    expect(out.json.texto).toMatch(/no pude guardar/i)
  })

  it('processed false → avisa que procesa más tarde', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 201, body: { folio: 'E-0001', processed: false, detalle: { transcription: null, vision_description: null, entities: [] } } },
      nodes,
    })
    expect(out.json.texto).toContain('E-0001')
    expect(out.json.texto).toMatch(/más tarde/)
  })
})
