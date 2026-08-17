import { describe, it, expect, beforeEach } from 'vitest'
import { proponerIdea, redactarBoceto, refinarBoceto, adaptarVersion } from '../src/services/redactor.js'

const llm = (content) => async (_u, opts) => {
  llm.lastBody = JSON.parse(opts.body)
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

const profile = { name: 'SkyTrace', identity_json: JSON.stringify({ tono: 'institucional', nunca_comunicar: ['precios'] }) }

describe('redactor', () => {
  beforeEach(() => { process.env.GROQ_API_KEY = 'gsk-test' })

  it('proponerIdea parsea el JSON del LLM', async () => {
    const fetchImpl = llm('{"titulo": "Prueba exitosa", "resumen": "Contar el vuelo"}')
    const res = await proponerIdea([{ tipo: 'audio', texto: 'probamos el dron' }], { fetchImpl })
    expect(res.title).toBe('Prueba exitosa')
    expect(res.summary).toBe('Contar el vuelo')
  })

  it('redactarBoceto inyecta el perfil y la evidencia en el prompt', async () => {
    const fetchImpl = llm('Hoy probamos el sistema…')
    const res = await redactarBoceto(profile, { title: 'T', summary: 'S' }, [{ texto: 'vuelo ok' }], { fetchImpl })
    expect(res.content).toBe('Hoy probamos el sistema…')
    const sys = JSON.stringify(llm.lastBody.messages)
    expect(sys).toContain('SkyTrace')
    expect(sys).toContain('institucional')
    expect(sys).toContain('vuelo ok')
  })

  it('refinarBoceto pasa el feedback', async () => {
    const fetchImpl = llm('Versión más técnica…')
    const res = await refinarBoceto(profile, 'texto viejo', 'menos épico, más técnico', [], { fetchImpl })
    expect(res.content).toBe('Versión más técnica…')
    expect(JSON.stringify(llm.lastBody.messages)).toContain('menos épico')
  })

  it('refinarBoceto incluye la evidencia para que no invente datos', async () => {
    const fetchImpl = llm('Versión corregida…')
    await refinarBoceto(profile, 'texto con 153 interacciones', 'no inventes datos', [{ texto: 'probamos el dron en Neuquén' }], { fetchImpl })
    expect(JSON.stringify(llm.lastBody.messages)).toContain('probamos el dron en Neuquén')
  })

  it('adaptarVersion devuelve texto y hashtags', async () => {
    const fetchImpl = llm('{"texto": "adaptado", "hashtags": "#drones #skytrace"}')
    const res = await adaptarVersion(profile, 'post aprobado', 'instagram', 'feed', { fetchImpl })
    expect(res.text).toBe('adaptado')
    expect(res.hashtags).toBe('#drones #skytrace')
  })

  it('JSON roto en proponerIdea lanza AiError', async () => {
    const fetchImpl = llm('no es json')
    await expect(proponerIdea([], { fetchImpl })).rejects.toThrow(/JSON/)
  })
})