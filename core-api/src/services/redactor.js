import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chat, AiError } from '../ai/client.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const prompt = (f) => readFileSync(path.join(HERE, '../../prompts', f), 'utf8')

function parseJson(content, contexto) {
  try { return JSON.parse(content) } catch {
    throw new AiError(`el LLM no devolvió JSON válido (${contexto})`)
  }
}

function perfilTexto(profile) {
  return `Nombre: ${profile.name}\n${profile.identity_json || '{}'}`
}

function evidenciaTexto(evidencias) {
  return evidencias.map((e, i) =>
    `- [${i + 1}] ${e.tipo || e.type || 'texto'}: ${e.texto || e.transcription || e.vision_description || e.text_content || ''}`
  ).join('\n') || '(sin evidencia)'
}

export async function proponerIdea(evidencias, { fetchImpl } = {}) {
  const { content, raw } = await chat('redactar', [
    { role: 'system', content: prompt('proponer-idea.md') },
    { role: 'user', content: evidenciaTexto(evidencias) },
  ], { json: true, fetchImpl })
  const parsed = parseJson(content, 'proponer idea')
  return { title: parsed.titulo || 'Idea sin título', summary: parsed.resumen || null, raw }
}

export async function redactarBoceto(profile, idea, evidencias, { fetchImpl } = {}) {
  const sys = prompt('redactar-boceto.md')
    .replace('__PERFIL__', () => perfilTexto(profile))
    .replace('__IDEA__', () => `${idea.title}${idea.summary ? ` — ${idea.summary}` : ''}`)
    .replace('__EVIDENCIA__', () => evidenciaTexto(evidencias))
  const { content, raw } = await chat('redactar', [
    { role: 'system', content: sys },
    { role: 'user', content: 'Escribí el post.' },
  ], { fetchImpl })
  return { content: content.trim(), raw }
}

export async function refinarBoceto(profile, contenidoActual, feedback, { fetchImpl } = {}) {
  const { content, raw } = await chat('redactar', [
    { role: 'system', content: `Sos el ghostwriter de ${profile.name}. Reescribí el post aplicando el pedido del usuario. Mantené el perfil de marca:\n${perfilTexto(profile)}\nDevolvé SOLO el texto del post.` },
    { role: 'user', content: `POST ACTUAL:\n${contenidoActual}\n\nPEDIDO:\n${feedback}` },
  ], { fetchImpl })
  return { content: content.trim(), raw }
}

export async function adaptarVersion(profile, contenido, channelCode, formatCode, { fetchImpl } = {}) {
  const sys = prompt('adaptar-version.md')
    .replace('__PERFIL__', () => perfilTexto(profile))
    .replace('__POST__', () => contenido)
    .replace('__CANAL__', () => channelCode)
    .replace('__FORMATO__', () => formatCode)
  const { content, raw } = await chat('redactar', [
    { role: 'system', content: sys },
    { role: 'user', content: 'Adaptá el post.' },
  ], { json: true, fetchImpl })
  const parsed = parseJson(content, 'adaptar versión')
  return { text: parsed.texto || contenido, hashtags: parsed.hashtags || '', raw }
}