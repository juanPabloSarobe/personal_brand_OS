# Plan B1 — Capa de IA y procesamiento de evidencia (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar cerebro a la core-api: router configurable de modelos, cliente Groq (chat, transcripción Whisper, visión), extracción de entidades con prompt versionado, y el pipeline que procesa cada evidencia al entrar (transcripción, descripción visual, entidades) sin romper jamás la captura si la IA falla.

**Architecture:** Todo dentro de core-api (spec §2: la core-api es dueña del cerebro). Módulos `src/ai/*` (proveedores, sin estado), `src/services/*` (pipeline con db), prompt en `prompts/entidades.md`. Todos los llamados HTTP a IA usan `fetchImpl` inyectable — los tests jamás tocan la red. Regla de oro (spec §5): si la IA falla, la evidencia queda guardada igual.

**Tech Stack:** Node 22 ESM · fetch nativo · Groq API (compatible OpenAI) · Vitest.

**Plan series:** A ✅ · **B1 (este)** · B2 (puente-telegram + n8n + compose) · C (conversación creativa) · D (publicadores) · E (onboarding conversacional). Spec: `docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`.

## Global Constraints

- JavaScript plano ESM, Node 22, sin dependencias nuevas (fetch/FormData/Blob nativos de Node 22).
- **Los modelos son configuración, nunca código** (spec §3): defaults en `src/ai/models.js`, override por env `AI_ROUTES_JSON`.
- Tareas de IA y modelos default exactos:
  - `transcribir` → groq / `whisper-large-v3`
  - `vision` → groq / `meta-llama/llama-4-scout-17b-16e-instruct`
  - `redactar` → groq / `llama-3.3-70b-versatile` (la usa el Plan C; el router ya la conoce)
  - `extraer_entidades` → groq / `llama-3.3-70b-versatile`
- Base Groq: `https://api.groq.com/openai/v1`. API key: env `GROQ_API_KEY`.
- **Regla de oro:** el pipeline NUNCA lanza hacia la ruta; toda falla de IA deja la evidencia intacta y devuelve `processed: false`. Sin `GROQ_API_KEY` → skip silencioso con razón.
- El JSON crudo de cada llamada IA se guarda en `evidence.raw_llm_json` (auditoría, patrón HSE).
- Kinds de entidad exactos (schema): `persona`, `empresa`, `tecnologia`, `proyecto`, `lugar`, `evento`.
- Tests sin red: todo llamado IA vía `fetchImpl` mockeado. Strings de usuario/API en español.
- TDD por task. Commits frecuentes. Branch: `claude/nuevo-proyecto-dxakbn`.

## File Structure

```
core-api/
  prompts/
    entidades.md               # prompt de extracción (fuente única, versionada)
  src/
    ai/
      models.js                # router tarea → proveedor/modelo (config)
      client.js                # chat / transcribe / describeImage + AiError
      entities.js              # extractEntities(text) → lista validada
    services/
      entities-store.js        # upsert de entidades + menciones (db)
      evidence-pipeline.js     # processEvidence(db, id) — orquesta todo
    routes/evidence.js         # (modif) integra pipeline + hardening + GET /:id
  tests/
    ai-models.test.js
    ai-client.test.js
    ai-entities.test.js
    evidence-hardening.test.js
    entities-store.test.js
    evidence-pipeline.test.js
    evidence-integration.test.js
```

---

### Task 1: Router de modelos por tarea

**Files:**
- Create: `core-api/src/ai/models.js`
- Test: `core-api/tests/ai-models.test.js`

**Interfaces:**
- Produces: `routeFor(task) → { provider, model }`; lanza `Error(/desconocida/)` para tarea no mapeada; override por env `AI_ROUTES_JSON` (JSON `{tarea: {provider?, model?}}`).

- [ ] **Step 1: Test que falla**

`core-api/tests/ai-models.test.js`:

```js
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
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/ai-models.test.js`
Expected: FAIL — `Cannot find module '../src/ai/models.js'`

- [ ] **Step 3: Implementar**

`core-api/src/ai/models.js`:

```js
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
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/ai-models.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/ai/models.js core-api/tests/ai-models.test.js
git commit -m "feat(core-api): router configurable de modelos de IA por tarea"
```

---

### Task 2: Cliente de IA (chat, transcripción, visión)

**Files:**
- Create: `core-api/src/ai/client.js`
- Test: `core-api/tests/ai-client.test.js`

**Interfaces:**
- Consumes: `routeFor` (Task 1).
- Produces (Plan C reutiliza `chat`):
  - `class AiError extends Error`
  - `chat(task, messages, {json?, fetchImpl?}) → {content, raw}`
  - `transcribe(buffer, filename, {fetchImpl?}) → {text, raw}`
  - `describeImage(buffer, mime, {fetchImpl?}) → {content, raw}`
  - Sin `GROQ_API_KEY` → lanza `AiError(/API key/)`. HTTP no-ok → `AiError` con status.

- [ ] **Step 1: Test que falla**

`core-api/tests/ai-client.test.js`:

```js
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
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/ai-client.test.js`
Expected: FAIL — `Cannot find module '../src/ai/client.js'`

- [ ] **Step 3: Implementar**

`core-api/src/ai/client.js`:

```js
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
  })
  if (!res.ok) throw new AiError(`IA ${provider}/${model} respondió ${res.status}: ${await res.text()}`)
  const raw = await res.json()
  return { content: raw.choices[0].message.content, raw }
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
  })
  if (!res.ok) throw new AiError(`IA ${provider}/${model} respondió ${res.status}: ${await res.text()}`)
  const raw = await res.json()
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
```

- [ ] **Step 4: Verificar que pasa (suite completa)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites (35 previos + 6 nuevos)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/ai/client.js core-api/tests/ai-client.test.js
git commit -m "feat(core-api): cliente Groq con chat, transcripcion y vision"
```

---

### Task 3: Prompt y extracción de entidades

**Files:**
- Create: `core-api/prompts/entidades.md`
- Create: `core-api/src/ai/entities.js`
- Test: `core-api/tests/ai-entities.test.js`

**Interfaces:**
- Consumes: `chat` (Task 2).
- Produces: `extractEntities(text, {fetchImpl?}) → { entities: [{kind, name}], raw }` — kinds fuera del catálogo se filtran; JSON inválido del LLM → `AiError(/JSON/)`.

- [ ] **Step 1: Escribir el prompt**

`core-api/prompts/entidades.md`:

```markdown
Sos un extractor de entidades para un sistema de marca personal. Recibís un texto
en español (transcripción de audio, descripción de una foto o texto libre) sobre
avances personales y laborales.

Devolvé SOLO un objeto JSON con esta forma exacta:

{"entidades": [{"kind": "<tipo>", "name": "<nombre propio>"}]}

Tipos permitidos (kind): persona, empresa, tecnologia, proyecto, lugar, evento.

Reglas:
- Solo nombres propios concretos (personas, empresas, tecnologías con nombre,
  proyectos, lugares específicos, eventos). Nada genérico ("un cliente", "la obra").
- No inventes: si no hay entidades claras, devolvé {"entidades": []}.
- El name va con su grafía normal (ej. "SkyTrace", "Polo Tecnológico", "YOLO").
- Sin texto fuera del JSON.
```

- [ ] **Step 2: Test que falla**

`core-api/tests/ai-entities.test.js`:

```js
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
```

- [ ] **Step 3: Verificar que falla**

Run: `cd core-api && npx vitest run tests/ai-entities.test.js`
Expected: FAIL — `Cannot find module '../src/ai/entities.js'`

- [ ] **Step 4: Implementar**

`core-api/src/ai/entities.js`:

```js
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
  const list = Array.isArray(parsed.entidades) ? parsed.entidades : []
  const entities = list.filter(e =>
    e && KINDS.includes(e.kind) && typeof e.name === 'string' && e.name.trim().length > 0
  ).map(e => ({ kind: e.kind, name: e.name.trim() }))
  return { entities, raw }
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/ai-entities.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add core-api/prompts/entidades.md core-api/src/ai/entities.js core-api/tests/ai-entities.test.js
git commit -m "feat(core-api): extraccion de entidades con prompt versionado"
```

---

### Task 4: Hardening de evidencia (deuda del Plan A)

**Files:**
- Modify: `core-api/src/routes/evidence.js`
- Test: `core-api/tests/evidence-hardening.test.js`

**Interfaces:**
- Consumes: ruta evidence existente.
- Produces: base64 inválido → 400 `'content_base64 inválido'`; si el INSERT falla después de escribir el archivo, el archivo se borra (sin huérfanos) y el error sigue su curso al handler global.

- [ ] **Step 1: Test que falla**

`core-api/tests/evidence-hardening.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { readdirSync } from 'node:fs'
import { makeTestApp, ADMIN_CHAT } from './helpers.js'

describe('hardening de evidencia', () => {
  it('rechaza base64 inválido con 400', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'foto', filename: 'x.jpg', content_base64: '!!!esto no es base64!!!' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'content_base64 inválido' })
  })

  it('si el INSERT falla, no queda archivo huérfano', async () => {
    const { app, db } = makeTestApp()
    db.exec('DROP TABLE evidence') // fuerza fallo del INSERT tras escribir el archivo
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'foto', filename: 'x.jpg', content_base64: Buffer.from('img').toString('base64') })
    expect(res.status).toBe(500)
    expect(readdirSync(process.env.MEDIA_DIR, { recursive: true })).toHaveLength(0)
  })
})
```

Nota: el segundo test requiere que `MEDIA_DIR` exista aunque el INSERT falle — la implementación crea el dir antes de escribir, así que `readdirSync` no debe lanzar; si el dir no existe (porque el archivo nunca se escribió y el dir tampoco se creó), tratarlo como éxito equivalente: envolver en try/catch y aceptar ENOENT como "sin huérfanos". Usar este helper dentro del test si hace falta:

```js
function filesIn(dir) {
  try { return readdirSync(dir, { recursive: true }) } catch { return [] }
}
```

(y assertear `expect(filesIn(process.env.MEDIA_DIR)).toHaveLength(0)`).

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/evidence-hardening.test.js`
Expected: FAIL — el base64 inválido hoy se acepta (201) y el archivo huérfano queda

- [ ] **Step 3: Implementar**

En `core-api/src/routes/evidence.js`:

1. Agregar el validador arriba del router:

```js
function isValidBase64(s) {
  return typeof s === 'string' && s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}
```

2. En el POST, después de las validaciones de tipo existentes y antes de escribir:

```js
    if (content_base64 && !isValidBase64(content_base64)) {
      return res.status(400).json({ error: 'content_base64 inválido' })
    }
```

3. Envolver el INSERT para limpiar el archivo si falla (reemplaza el bloque del INSERT):

```js
    let info
    try {
      info = db.prepare(`
        INSERT INTO evidence (user_id, type, file_path, text_content, context_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.user.id, type, filePath, text, JSON.stringify(context))
    } catch (err) {
      if (filePath) { try { unlinkSync(filePath) } catch {} }
      throw err
    }
```

y agregar `unlinkSync` al import de `node:fs`.

- [ ] **Step 4: Verificar que pasa (suite completa)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites

- [ ] **Step 5: Commit**

```bash
git add core-api/src/routes/evidence.js core-api/tests/evidence-hardening.test.js
git commit -m "fix(core-api): validar base64 y limpiar archivos huerfanos en evidencia"
```

---

### Task 5: Almacén de entidades y menciones

**Files:**
- Create: `core-api/src/services/entities-store.js`
- Test: `core-api/tests/entities-store.test.js`

**Interfaces:**
- Consumes: tablas `entities`, `entity_mentions` (schema Plan A).
- Produces: `recordMentions(db, {evidenceId?, ideaId?}, entities) → [{entityId, kind, name}]` — upsert idempotente por (kind, name), inserta una mención por entidad; sin duplicar menciones del mismo (entity, evidence).

- [ ] **Step 1: Test que falla**

`core-api/tests/entities-store.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { makeTestApp } from './helpers.js'
import { recordMentions } from '../src/services/entities-store.js'

function withEvidence(db) {
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  return db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid
}

describe('almacén de entidades', () => {
  it('crea entidades nuevas y registra menciones', () => {
    const { db } = makeTestApp()
    const evId = withEvidence(db)
    const out = recordMentions(db, { evidenceId: evId }, [
      { kind: 'empresa', name: 'SkyTrace' },
      { kind: 'lugar', name: 'Polo Tecnológico' },
    ])
    expect(out).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions WHERE evidence_id = ?').get(evId).n).toBe(2)
  })

  it('reutiliza la entidad existente (upsert por kind+name)', () => {
    const { db } = makeTestApp()
    const ev1 = withEvidence(db)
    const ev2 = withEvidence(db)
    recordMentions(db, { evidenceId: ev1 }, [{ kind: 'empresa', name: 'SkyTrace' }])
    recordMentions(db, { evidenceId: ev2 }, [{ kind: 'empresa', name: 'SkyTrace' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions').get().n).toBe(2)
  })

  it('no duplica la mención de la misma entidad en la misma evidencia', () => {
    const { db } = makeTestApp()
    const evId = withEvidence(db)
    recordMentions(db, { evidenceId: evId }, [{ kind: 'empresa', name: 'SkyTrace' }])
    recordMentions(db, { evidenceId: evId }, [{ kind: 'empresa', name: 'SkyTrace' }])
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions WHERE evidence_id = ?').get(evId).n).toBe(1)
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/entities-store.test.js`
Expected: FAIL — `Cannot find module '../src/services/entities-store.js'`

- [ ] **Step 3: Implementar**

`core-api/src/services/entities-store.js`:

```js
export function recordMentions(db, { evidenceId = null, ideaId = null }, entities) {
  const out = []
  const upsert = db.prepare('INSERT INTO entities (kind, name) VALUES (?, ?) ON CONFLICT (kind, name) DO NOTHING')
  const find = db.prepare('SELECT id FROM entities WHERE kind = ? AND name = ?')
  const exists = db.prepare(`
    SELECT id FROM entity_mentions
    WHERE entity_id = ? AND evidence_id IS ? AND idea_id IS ?
  `)
  const mention = db.prepare('INSERT INTO entity_mentions (entity_id, evidence_id, idea_id) VALUES (?, ?, ?)')

  for (const { kind, name } of entities) {
    upsert.run(kind, name)
    const entityId = find.get(kind, name).id
    if (!exists.get(entityId, evidenceId, ideaId)) mention.run(entityId, evidenceId, ideaId)
    out.push({ entityId, kind, name })
  }
  return out
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/entities-store.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/services/entities-store.js core-api/tests/entities-store.test.js
git commit -m "feat(core-api): upsert de entidades y registro de menciones"
```

---

### Task 6: Pipeline de procesamiento de evidencia

**Files:**
- Create: `core-api/src/services/evidence-pipeline.js`
- Test: `core-api/tests/evidence-pipeline.test.js`

**Interfaces:**
- Consumes: `transcribe`/`describeImage` (Task 2), `extractEntities` (Task 3), `recordMentions` (Task 5).
- Produces: `processEvidence(db, evidenceId, {fetchImpl?}) → {processed, reason?}` — NUNCA lanza:
  - audio → guarda `transcription`; foto → guarda `vision_description`; siempre que haya texto (text_content/transcription/vision) → entidades + menciones.
  - Sin `GROQ_API_KEY` → `{processed: false, reason: 'sin GROQ_API_KEY'}` sin tocar la fila.
  - Cualquier `AiError`/fallo → evidencia intacta, `raw_llm_json` guarda `{error}`, `{processed:false, reason}`.
  - Éxito → `raw_llm_json` guarda los raw de cada paso.

- [ ] **Step 1: Test que falla**

`core-api/tests/evidence-pipeline.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { makeTestApp } from './helpers.js'
import { processEvidence } from '../src/services/evidence-pipeline.js'

function insertEvidence(db, { type, filePath = null, text = null }) {
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  return db.prepare(
    'INSERT INTO evidence (user_id, type, file_path, text_content) VALUES (?, ?, ?, ?)'
  ).run(userId, type, filePath, text).lastInsertRowid
}

function mediaFile(name, content) {
  mkdirSync(process.env.MEDIA_DIR, { recursive: true })
  const p = path.join(process.env.MEDIA_DIR, name)
  writeFileSync(p, content)
  return p
}

function fetchRouter({ transcription = 'texto transcripto', vision = 'una foto de prueba', entidades = [] } = {}) {
  return async (url, opts) => {
    if (url.includes('/audio/transcriptions')) {
      return { ok: true, json: async () => ({ text: transcription }) }
    }
    const body = JSON.parse(opts.body)
    const isVision = JSON.stringify(body.messages).includes('image_url')
    const content = isVision ? vision : JSON.stringify({ entidades })
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  }
}

describe('pipeline de evidencia', () => {
  beforeEach(() => { process.env.GROQ_API_KEY = 'gsk-test' })

  it('audio: transcribe, extrae entidades y audita raw', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('nota.ogg', 'audio')
    const id = insertEvidence(db, { type: 'audio', filePath: p })
    const res = await processEvidence(db, id, {
      fetchImpl: fetchRouter({ transcription: 'probamos SkyTrace', entidades: [{ kind: 'empresa', name: 'SkyTrace' }] }),
    })
    expect(res.processed).toBe(true)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    expect(row.transcription).toBe('probamos SkyTrace')
    expect(row.raw_llm_json).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_mentions WHERE evidence_id = ?').get(id).n).toBe(1)
  })

  it('foto: describe con visión', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('foto.jpg', 'img')
    const id = insertEvidence(db, { type: 'foto', filePath: p })
    const res = await processEvidence(db, id, { fetchImpl: fetchRouter({ vision: 'banco de pruebas con drones' }) })
    expect(res.processed).toBe(true)
    expect(db.prepare('SELECT vision_description FROM evidence WHERE id = ?').get(id).vision_description)
      .toBe('banco de pruebas con drones')
  })

  it('sin GROQ_API_KEY: skip sin tocar la fila', async () => {
    const { db } = makeTestApp()
    delete process.env.GROQ_API_KEY
    const id = insertEvidence(db, { type: 'texto', text: 'hola' })
    const res = await processEvidence(db, id)
    expect(res).toEqual({ processed: false, reason: 'sin GROQ_API_KEY' })
    expect(db.prepare('SELECT raw_llm_json FROM evidence WHERE id = ?').get(id).raw_llm_json).toBeNull()
  })

  it('IA caída: la evidencia queda intacta y processed false', async () => {
    const { db } = makeTestApp()
    process.env.GROQ_API_KEY = 'gsk-test'
    const p = mediaFile('nota2.ogg', 'audio')
    const id = insertEvidence(db, { type: 'audio', filePath: p })
    const res = await processEvidence(db, id, { fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }) })
    expect(res.processed).toBe(false)
    expect(res.reason).toMatch(/503/)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id)
    expect(row.transcription).toBeNull()
    expect(JSON.parse(row.raw_llm_json).error).toMatch(/503/)
  })

  it('evidencia inexistente', async () => {
    const { db } = makeTestApp()
    const res = await processEvidence(db, 9999)
    expect(res).toEqual({ processed: false, reason: 'inexistente' })
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/evidence-pipeline.test.js`
Expected: FAIL — `Cannot find module '../src/services/evidence-pipeline.js'`

- [ ] **Step 3: Implementar**

`core-api/src/services/evidence-pipeline.js`:

```js
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transcribe, describeImage } from '../ai/client.js'
import { extractEntities } from '../ai/entities.js'
import { recordMentions } from './entities-store.js'

const MIMES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

export async function processEvidence(db, evidenceId, { fetchImpl } = {}) {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId)
  if (!ev) return { processed: false, reason: 'inexistente' }
  if (!process.env.GROQ_API_KEY) return { processed: false, reason: 'sin GROQ_API_KEY' }

  const raws = {}
  try {
    let transcription = null
    let vision = null

    if (ev.type === 'audio' && ev.file_path) {
      const r = await transcribe(readFileSync(ev.file_path), path.basename(ev.file_path), { fetchImpl })
      transcription = r.text
      raws.transcripcion = r.raw
      db.prepare('UPDATE evidence SET transcription = ? WHERE id = ?').run(transcription, ev.id)
    }

    if (ev.type === 'foto' && ev.file_path) {
      const mime = MIMES[path.extname(ev.file_path).toLowerCase()] || 'image/jpeg'
      const r = await describeImage(readFileSync(ev.file_path), mime, { fetchImpl })
      vision = r.content
      raws.vision = r.raw
      db.prepare('UPDATE evidence SET vision_description = ? WHERE id = ?').run(vision, ev.id)
    }

    const fullText = [ev.text_content, transcription, vision].filter(Boolean).join('\n')
    if (fullText.trim()) {
      const r = await extractEntities(fullText, { fetchImpl })
      raws.entidades = r.raw
      recordMentions(db, { evidenceId: ev.id }, r.entities)
    }

    db.prepare('UPDATE evidence SET raw_llm_json = ? WHERE id = ?').run(JSON.stringify(raws), ev.id)
    return { processed: true }
  } catch (err) {
    db.prepare('UPDATE evidence SET raw_llm_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...raws, error: String(err) }), ev.id)
    return { processed: false, reason: String(err) }
  }
}
```

- [ ] **Step 4: Verificar que pasa (suite completa)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites

- [ ] **Step 5: Commit**

```bash
git add core-api/src/services/evidence-pipeline.js core-api/tests/evidence-pipeline.test.js
git commit -m "feat(core-api): pipeline de procesamiento de evidencia con regla de oro"
```

---

### Task 7: Integración en la ruta de evidencia + detalle con entidades

**Files:**
- Modify: `core-api/src/routes/evidence.js`
- Modify: `core-api/src/app.js`
- Test: `core-api/tests/evidence-integration.test.js`

**Interfaces:**
- Consumes: `processEvidence` (Task 6).
- Produces:
  - `POST /api/evidence` ahora responde `{id, folio, processed}` (procesa sincrónico tras guardar; jamás falla por IA).
  - `GET /api/evidence/:id` → fila del dueño (403 si es de otro usuario, 404 si no existe) + `entities: [{kind, name}]`.
  - Inyección de fetch para tests: `createApp(db, {aiFetch})` — tercer parámetro opcional; la ruta usa `app.locals.aiFetch` si existe.

- [ ] **Step 1: Test que falla**

`core-api/tests/evidence-integration.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeAiApp(fetchImpl) {
  process.env.MASTER_KEY = 'ab'.repeat(32)
  process.env.ADMIN_CHAT_ID = ADMIN_CHAT
  process.env.ADMIN_NAME = 'Juan Pablo'
  process.env.GROQ_API_KEY = 'gsk-test'
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-ai-'))
  process.env.MEDIA_DIR = path.join(dir, 'media')
  const db = openDb({ dbPath: path.join(dir, 'test.db') })
  return { app: createApp(db, { aiFetch: fetchImpl }), db }
}

const aiOk = async (url, opts) => {
  if (url.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'probamos SkyTrace hoy' }) }
  const body = JSON.parse(opts.body)
  const isVision = JSON.stringify(body.messages).includes('image_url')
  const content = isVision ? 'foto del dron' : JSON.stringify({ entidades: [{ kind: 'empresa', name: 'SkyTrace' }] })
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

describe('integración evidencia + IA', () => {
  it('POST de audio procesa y devuelve processed true', async () => {
    const { app, db } = makeAiApp(aiOk)
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'audio', filename: 'nota.ogg', content_base64: Buffer.from('audio').toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(true)
    const row = db.prepare('SELECT transcription FROM evidence WHERE id = ?').get(res.body.id)
    expect(row.transcription).toBe('probamos SkyTrace hoy')
  })

  it('GET /:id devuelve la evidencia con sus entidades', async () => {
    const { app } = makeAiApp(aiOk)
    const created = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'reunión con SkyTrace' })
    const res = await request(app).get(`/api/evidence/${created.body.id}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(res.status).toBe(200)
    expect(res.body.entities).toEqual([{ kind: 'empresa', name: 'SkyTrace' }])
  })

  it('GET /:id ajeno → 403; inexistente → 404', async () => {
    const { app, db } = makeAiApp(aiOk)
    const created = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'privado' })
    addUser(db, '222')
    const ajeno = await request(app).get(`/api/evidence/${created.body.id}`).set('X-Telegram-Chat-Id', '222')
    expect(ajeno.status).toBe(403)
    const nada = await request(app).get('/api/evidence/99999').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(nada.status).toBe(404)
  })

  it('IA caída: el POST igual guarda (processed false)', async () => {
    const { app, db } = makeAiApp(async () => ({ ok: false, status: 503, text: async () => 'down' }))
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'audio', filename: 'n.ogg', content_base64: Buffer.from('a').toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n).toBe(1)
  })

  it('makeTestApp sigue funcionando sin aiFetch (sin GROQ_API_KEY no procesa)', async () => {
    const { app } = makeTestApp()
    delete process.env.GROQ_API_KEY
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'sin ia' })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(false)
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/evidence-integration.test.js`
Expected: FAIL — `processed` undefined y GET /:id → 404 (ruta inexistente)

- [ ] **Step 3: Implementar**

En `core-api/src/app.js`: cambiar la firma a `createApp(db, { aiFetch } = {})` y dentro del `if (db)` agregar `app.locals.aiFetch = aiFetch` (antes de montar routers).

En `core-api/src/routes/evidence.js`:

1. Import: `import { processEvidence } from '../services/evidence-pipeline.js'`
2. El handler del POST pasa a async y, tras el INSERT exitoso:

```js
    const id = info.lastInsertRowid
    const result = await processEvidence(db, id, { fetchImpl: req.app.locals.aiFetch })
    res.status(201).json({ id, folio: `E-${String(id).padStart(4, '0')}`, processed: result.processed })
```

3. Nueva ruta GET /:id (después del GET /):

```js
  r.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(Number(req.params.id))
    if (!row) return res.status(404).json({ error: 'evidencia inexistente' })
    if (row.user_id !== req.user.id) return res.status(403).json({ error: 'sin acceso a la evidencia' })
    const entities = db.prepare(`
      SELECT e.kind, e.name FROM entity_mentions m
      JOIN entities e ON e.id = m.entity_id
      WHERE m.evidence_id = ? ORDER BY e.id
    `).all(row.id)
    res.json({ ...row, entities })
  })
```

- [ ] **Step 4: Verificar que pasa (suite completa)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites

- [ ] **Step 5: Commit**

```bash
git add core-api/src/app.js core-api/src/routes/evidence.js core-api/tests/evidence-integration.test.js
git commit -m "feat(core-api): la evidencia se procesa con IA al entrar y expone sus entidades"
```

---

### Task 8: Configuración, README y cierre

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: documentación de `GROQ_API_KEY` (activa) y `AI_ROUTES_JSON` (opcional) para la Mac mini.

- [ ] **Step 1: Actualizar .env.example**

Reemplazar el bloque final de `.env.example` (el de "Planes siguientes") por:

```bash
# IA (Plan B1) — crear la key gratis en console.groq.com
GROQ_API_KEY=

# Override opcional de modelos por tarea (JSON). Ejemplo:
# AI_ROUTES_JSON={"redactar":{"model":"qwen/qwen3-32b"}}
AI_ROUTES_JSON=

# --- Planes siguientes (dejar vacío por ahora) ---
# TELEGRAM_BOT_TOKEN=   (Plan B2)
```

- [ ] **Step 2: Actualizar README**

En `README.md`, bajo la sección "## Levantar en la Mac mini", agregar al final:

```markdown
### IA (opcional pero recomendado)

Con `GROQ_API_KEY` configurada (gratis en [console.groq.com](https://console.groq.com)),
cada evidencia se procesa al entrar: los audios se transcriben (Whisper), las fotos se
describen (visión) y se detectan entidades (personas, empresas, tecnologías, lugares).
Sin la key, la captura funciona igual — solo no se procesa.
```

- [ ] **Step 3: Suite completa una vez más**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites en verde

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: configuracion de IA (GROQ_API_KEY y AI_ROUTES_JSON)"
```

---

## Self-Review del plan (ejecutada)

1. **Cobertura vs spec:** cubre spec §3 (capa de IA: router config, Groq, separación procesar/generar — la generación de imagen NO entra, es opcional post-v1), §4.7 (transcription/vision_description/raw_llm_json), §4.12 (extracción automática de entidades + menciones), §5-regla de oro (captura nunca se pierde por IA), y las dos deudas del Plan A sobre evidencia (base64, huérfanos). No cubre (asignado): puente-telegram/n8n/respuestas → Plan B2; conversación/ideas → Plan C; etiquetado social propuesto → Plan C (usa handles_json ya existente).
2. **Placeholders:** ninguno; todo step con código completo y comando con salida esperada.
3. **Consistencia de tipos:** `routeFor(task)`, `chat/transcribe/describeImage({fetchImpl})`, `extractEntities → {entities, raw}`, `recordMentions(db, {evidenceId, ideaId}, entities)`, `processEvidence(db, id, {fetchImpl}) → {processed, reason?}`, `createApp(db, {aiFetch})` — firmas idénticas entre tasks y tests.
