import { describe, it, expect, beforeEach } from 'vitest'
import { extractEntities } from '../src/ai/entities.js'

function llmReply(content) {
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })
}

describe('extracción de entidades', () => {
  beforeEach(() => { process.env.GROQ_API_KEY = 'gsk-test' })

  it('devuelve entidades válidas del JSON del LLM', async () => {
    const fetchImpl = llmReply(JSON.stringify({
      entidades: [
        { kind: 'empresa', name: 'SkyTrace' },
        { kind: 'lugar', name: 'Polo Tecnológico' },
      ],
    }))
    const res = await extractEntities('probamos el dron de SkyTrace en el Polo Tecnológico', { fetchImpl })
    expect(res.entities).toEqual([
      { kind: 'empresa', name: 'SkyTrace' },
      { kind: 'lugar', name: 'Polo Tecnológico' },
    ])
  })

  it('filtra kinds fuera de catálogo y names vacíos', async () => {
    const fetchImpl = llmReply(JSON.stringify({
      entidades: [
        { kind: 'sentimiento', name: 'alegría' },
        { kind: 'empresa', name: '  ' },
        { kind: 'tecnologia', name: 'YOLO' },
      ],
    }))
    const res = await extractEntities('texto', { fetchImpl })
    expect(res.entities).toEqual([{ kind: 'tecnologia', name: 'YOLO' }])
  })

  it('JSON roto del LLM lanza AiError', async () => {
    const fetchImpl = llmReply('esto no es json {')
    await expect(extractEntities('texto', { fetchImpl })).rejects.toThrow(/JSON/)
  })

  it('respuesta sin lista devuelve vacío', async () => {
    const fetchImpl = llmReply('{"otra_cosa": 1}')
    const res = await extractEntities('texto', { fetchImpl })
    expect(res.entities).toEqual([])
  })
})
