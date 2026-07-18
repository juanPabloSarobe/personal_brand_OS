const DEFAULTS = {
  transcribir: { provider: 'groq', model: 'whisper-large-v3' },
  vision: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  redactar: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  extraer_entidades: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
}

export function routeFor(task) {
  const base = DEFAULTS[task]
  if (!base) throw new Error(`tarea de IA desconocida: ${task}`)
  let overrides = {}
  try { overrides = JSON.parse(process.env.AI_ROUTES_JSON || '{}') } catch { overrides = {} }
  return { ...base, ...(overrides[task] || {}) }
}
