import { routeFor } from './models.js'

const BASES = { groq: 'https://api.groq.com/openai/v1' }
const KEYS = { groq: 'GROQ_API_KEY' }

export class AiError extends Error {}

function auth(provider) {
  const key = process.env[KEYS[provider]]
  if (!key) throw new AiError(`falta API key para ${provider} (${KEYS[provider]})`)
  return key
}

export async function chat(task, messages, { json = false, fetchImpl = fetch } = {}) {
  const { provider, model } = routeFor(task)
  const res = await fetchImpl(`${BASES[provider]}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth(provider)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new AiError(`IA ${provider}/${model} respondió ${res.status}: ${await res.text()}`)
  const raw = await res.json()
  const content = raw.choices?.[0]?.message?.content
  if (content === undefined) throw new AiError('respuesta de IA sin choices')
  return { content, raw }
}

export async function transcribe(buffer, filename, { fetchImpl = fetch } = {}) {
  const { provider, model } = routeFor('transcribir')
  const form = new FormData()
  form.append('file', new Blob([buffer]), filename)
  form.append('model', model)
  const res = await fetchImpl(`${BASES[provider]}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth(provider)}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new AiError(`IA ${provider}/${model} respondió ${res.status}: ${await res.text()}`)
  const raw = await res.json()
  if (typeof raw.text !== 'string') throw new AiError('respuesta de IA sin texto')
  return { text: raw.text, raw }
}

export async function describeImage(buffer, mime, { fetchImpl = fetch } = {}) {
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
  return chat('vision', [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describí esta imagen en español, en 2 o 3 frases, con foco en qué se ve y su contexto profesional o técnico si lo hay.' },
      { type: 'image_url', image_url: { url: dataUri } },
    ],
  }], { fetchImpl })
}
