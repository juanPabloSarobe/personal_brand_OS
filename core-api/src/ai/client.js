import { routeFor } from './models.js'

const BASES = {
  groq: 'https://api.groq.com/openai/v1',
  // modelo local vía Ollama. Desde el contenedor, el host se ve como
  // host.docker.internal; se puede pisar con OLLAMA_BASE_URL (p. ej. para correr
  // core-api fuera de Docker, o apuntar a otra máquina de la red).
  ollama: 'http://host.docker.internal:11434/v1',
}
// Proveedores sin entrada acá no llevan credenciales (los locales).
const KEYS = { groq: 'GROQ_API_KEY' }

export class AiError extends Error {}

function baseFor(provider) {
  if (provider === 'ollama' && process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL
  const base = BASES[provider]
  if (!base) throw new AiError(`proveedor de IA desconocido: ${provider}`)
  return base
}

function authHeaders(provider) {
  const envName = KEYS[provider]
  if (!envName) return {}
  const key = process.env[envName]
  if (!key) throw new AiError(`falta API key para ${provider} (${envName})`)
  return { Authorization: `Bearer ${key}` }
}

// Un modelo local en la Mac mini tarda mucho más que la nube, sobre todo con
// imágenes: 30s le quedan cortos y cortaría la respuesta a mitad de camino.
export function timeoutMs(provider) {
  const override = Number(process.env.AI_TIMEOUT_MS)
  if (Number.isFinite(override) && override > 0) return override
  return provider === 'ollama' ? 180000 : 30000
}

export async function chat(task, messages, { json = false, fetchImpl = fetch } = {}) {
  const { provider, model } = routeFor(task)
  const res = await fetchImpl(`${baseFor(provider)}/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs(provider)),
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
  const res = await fetchImpl(`${baseFor(provider)}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(provider),
    body: form,
    signal: AbortSignal.timeout(timeoutMs(provider)),
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
      // El "íntegramente en español" es por los modelos locales chicos, que arrancan
      // en español y se pasan al inglés a mitad de la descripción.
      { type: 'text', text: 'Describí esta imagen en 2 o 3 frases, con foco en qué se ve y su contexto profesional o técnico si lo hay. Respondé íntegramente en español: ni una palabra en inglés, salvo nombres propios o marcas que aparezcan en la imagen.' },
      { type: 'image_url', image_url: { url: dataUri } },
    ],
  }], { fetchImpl })
}
