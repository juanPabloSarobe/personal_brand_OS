import { describe, it, expect } from 'vitest'
import { runCodeNode } from './n8n-harness.js'

describe('nodo 01: preparar turno', () => {
  it('foto → camino evidencia', () => {
    const [out] = runCodeNode('01-preparar-turno.js', {
      json: { body: { chatId: '9', tipo: 'foto', filename: 'f.jpg', content_base64: 'QQ==', caption: 'obra' } },
    })
    expect(out.json.camino).toBe('evidencia')
    expect(out.json.evidencePost.type).toBe('foto')
  })

  it('texto → turno clase texto', () => {
    const [out] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'texto', texto: 'hola' } } })
    expect(out.json).toEqual({ chatId: '9', camino: 'turno', input: { clase: 'texto', texto: 'hola' } })
  })

  it('boton → turno clase boton', () => {
    const [out] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'boton', boton: 'idea_guardar' } } })
    expect(out.json.input).toEqual({ clase: 'boton', boton: 'idea_guardar' })
  })

  it('/start → ayuda local; otros comandos → turno', () => {
    const [ayuda] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'comando', comando: '/start' } } })
    expect(ayuda.json.camino).toBe('ayuda')
    expect(ayuda.json.texto).toMatch(/\/cola/)
    const [cola] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'comando', comando: '/cola', texto: '/cola' } } })
    expect(cola.json.input).toEqual({ clase: 'comando', comando: '/cola' })
  })

  it('/idea con argumento conserva el texto completo', () => {
    const [out] = runCodeNode('01-preparar-turno.js', {
      json: { body: { chatId: '9', tipo: 'comando', comando: '/idea', texto: '/idea Lanzar newsletter' } },
    })
    expect(out.json.input.comando).toBe('/idea Lanzar newsletter')
  })
})

describe('nodo 03: armar turno evidencia', () => {
  const nodes = { 'Preparar turno': { chatId: '9' } }
  it('201 → input evidencia', () => {
    const [out] = runCodeNode('03-armar-turno-evidencia.js', {
      json: { statusCode: 201, body: { id: 1, folio: 'E-0001', processed: true, detalle: { transcription: 'x', vision_description: null, entities: [] } } },
      nodes,
    })
    expect(out.json.input.clase).toBe('evidencia')
    expect(out.json.input.evidencia.folio).toBe('E-0001')
  })
  it('403 → respuestaDirecta silencio', () => {
    const [out] = runCodeNode('03-armar-turno-evidencia.js', { json: { statusCode: 403, body: {} }, nodes })
    expect(out.json.respuestaDirecta.responder).toBe(false)
  })
  it('error → respuestaDirecta fallback', () => {
    const [out] = runCodeNode('03-armar-turno-evidencia.js', { json: { error: 'ECONNREFUSED' }, nodes })
    expect(out.json.respuestaDirecta.responder).toBe(true)
    expect(out.json.respuestaDirecta.texto).toMatch(/no pude guardar/i)
  })
})

describe('nodo 02: armar respuesta v2', () => {
  const nodes = { 'Preparar turno': { chatId: '9' } }
  it('turno con botones → inline keyboard en filas de 3', () => {
    const botones = [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' },
    ]
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 200, body: { texto: 'elegí', botones, estado: 'x' } }, nodes,
    })
    expect(out.json.responder).toBe(true)
    expect(out.json.reply_markup.inline_keyboard).toEqual([
      [{ text: 'A', callback_data: 'a' }, { text: 'B', callback_data: 'b' }, { text: 'C', callback_data: 'c' }],
      [{ text: 'D', callback_data: 'd' }],
    ])
  })
  it('sin botones → sin reply_markup', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 200, body: { texto: 'ok', botones: [], estado: 'inicio' } }, nodes,
    })
    expect(out.json.reply_markup).toBeUndefined()
  })
  it('respuestaDirecta pasa tal cual', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { respuestaDirecta: { responder: false, chatId: '9' } }, nodes,
    })
    expect(out.json.responder).toBe(false)
  })
  it('ayuda pasa con texto', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { camino: 'ayuda', chatId: '9', texto: 'ayuda...' }, nodes,
    })
    expect(out.json).toMatchObject({ responder: true, chatId: '9', texto: 'ayuda...' })
  })
  it('403 del turno → silencio; error → fallback', () => {
    const [s] = runCodeNode('02-armar-respuesta.js', { json: { statusCode: 403, body: {} }, nodes })
    expect(s.json.responder).toBe(false)
    const [e] = runCodeNode('02-armar-respuesta.js', { json: { error: 'boom' }, nodes })
    expect(e.json.texto).toMatch(/falló|no pude/i)
  })
  it('trunca a 4000', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 200, body: { texto: 'a'.repeat(5000), botones: [], estado: 'x' } }, nodes,
    })
    expect(out.json.texto.length).toBeLessThanOrEqual(4000)
  })
})
