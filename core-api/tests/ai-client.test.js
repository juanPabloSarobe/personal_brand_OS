import { describe, it, expect, beforeEach } from 'vitest'
import { chat, transcribe, describeImage, AiError } from '../src/ai/client.js'

function okJson(payload) {
  return async () => ({ ok: true, json: async () => payload, text: async () => JSON.stringify(payload) })
}

describe('cliente de IA', () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'gsk-test'
    delete process.env.AI_ROUTES_JSON
  })

  it('chat devuelve content y raw', async () => {
    const raw = { choices: [{ message: { content: 'hola' } }] }
    let captured
    const fetchImpl = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => raw } }
    const res = await chat('redactar', [{ role: 'user', content: 'hola' }], { fetchImpl })
    expect(res.content).toBe('hola')
    expect(res.raw).toEqual(raw)
    expect(captured.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(JSON.parse(captured.opts.body).model).toBe('llama-3.3-70b-versatile')
    expect(captured.opts.headers.Authorization).toBe('Bearer gsk-test')
  })

  it('chat con json:true pide response_format json_object', async () => {
    let body
    const fetchImpl = async (_u, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) } }
    await chat('extraer_entidades', [], { json: true, fetchImpl })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('sin API key lanza AiError', async () => {
    delete process.env.GROQ_API_KEY
    await expect(chat('redactar', [], { fetchImpl: okJson({}) })).rejects.toThrow(/API key/)
  })

  it('HTTP no-ok lanza AiError con status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limit' })
    await expect(chat('redactar', [], { fetchImpl })).rejects.toThrow(AiError)
    await expect(chat('redactar', [], { fetchImpl })).rejects.toThrow(/429/)
  })

  it('transcribe manda multipart al endpoint de audio', async () => {
    let captured
    const fetchImpl = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ text: 'hola mundo' }) } }
    const res = await transcribe(Buffer.from('audio-fake'), 'nota.ogg', { fetchImpl })
    expect(res.text).toBe('hola mundo')
    expect(captured.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(captured.opts.body).toBeInstanceOf(FormData)
  })

  it('describeImage arma data URI y usa la tarea vision', async () => {
    let body
    const fetchImpl = async (_u, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'una foto' } }] }) } }
    const res = await describeImage(Buffer.from('img'), 'image/png', { fetchImpl })
    expect(res.content).toBe('una foto')
    expect(body.model).toBe('meta-llama/llama-4-scout-17b-16e-instruct')
    const img = body.messages[0].content.find(p => p.type === 'image_url')
    expect(img.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })
})
