import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chat, AiError } from './client.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROMPT = readFileSync(path.join(HERE, '../../prompts/entidades.md'), 'utf8')
const KINDS = ['persona', 'empresa', 'tecnologia', 'proyecto', 'lugar', 'evento']

export async function extractEntities(text, { fetchImpl } = {}) {
  const { content, raw } = await chat('extraer_entidades', [
    { role: 'system', content: PROMPT },
    { role: 'user', content: text },
  ], { json: true, fetchImpl })

  let parsed
  try { parsed = JSON.parse(content) } catch {
    throw new AiError('el LLM no devolvió JSON válido para entidades')
  }
  const list = Array.isArray(parsed?.entidades) ? parsed.entidades : []
  const entities = list.filter(e =>
    e && KINDS.includes(e.kind) && typeof e.name === 'string' && e.name.trim().length > 0
  ).map(e => ({ kind: e.kind, name: e.name.trim() }))
  return { entities, raw }
}
