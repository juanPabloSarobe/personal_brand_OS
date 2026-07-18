import { describe, it, expect, beforeEach } from 'vitest'
import { routeFor } from '../src/ai/models.js'

describe('router de modelos', () => {
  beforeEach(() => { delete process.env.AI_ROUTES_JSON })

  it('resuelve los defaults de cada tarea', () => {
    expect(routeFor('transcribir')).toEqual({ provider: 'groq', model: 'whisper-large-v3' })
    expect(routeFor('vision').model).toBe('meta-llama/llama-4-scout-17b-16e-instruct')
    expect(routeFor('redactar').model).toBe('llama-3.3-70b-versatile')
    expect(routeFor('extraer_entidades').provider).toBe('groq')
  })

  it('el env AI_ROUTES_JSON pisa el default sin tocar código', () => {
    process.env.AI_ROUTES_JSON = JSON.stringify({ redactar: { model: 'qwen/qwen3-32b' } })
    expect(routeFor('redactar')).toEqual({ provider: 'groq', model: 'qwen/qwen3-32b' })
    expect(routeFor('vision').model).toBe('meta-llama/llama-4-scout-17b-16e-instruct')
  })

  it('tarea desconocida lanza error', () => {
    expect(() => routeFor('adivinar_futuro')).toThrow(/desconocida/)
  })

  it('AI_ROUTES_JSON inválido se ignora sin romper', () => {
    process.env.AI_ROUTES_JSON = '{esto no es json'
    expect(routeFor('redactar')).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' })
  })
})
