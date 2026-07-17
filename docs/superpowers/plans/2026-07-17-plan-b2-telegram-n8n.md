# Plan B2 — Puente Telegram + n8n + orquestación (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar el circuito de captura: mandás foto/audio/texto al bot de Telegram desde el celular → el puente lo normaliza → n8n orquesta → la core-api lo archiva y procesa (B1) → el bot te confirma con folio, transcripción, descripción y entidades.

**Architecture:** Tres piezas nuevas: (1) `puente-telegram/` — servicio Node sin dependencias que hace long polling contra la Bot API (la Mac mini no expone puertos) y reenvía cada update normalizado al webhook local de n8n; (2) `n8n/` — workflow generado desde código versionado (patrón validado en el proyecto HSE del usuario: nodos Code como archivos en `src/`, `build-workflow.mjs` genera `workflow.json` importable); (3) compose orquesta todo. La core-api gana un campo `detalle` en la respuesta del POST de evidencia para que n8n arme el eco sin llamadas extra.

**Tech Stack:** Node 22 ESM (cero deps en el puente) · Telegram Bot API (getUpdates/getFile/sendMessage) · n8n (imagen oficial) · Docker Compose.

**Plan series:** A ✅ · B1 ✅ · **B2 (este)** · C · D · E. Spec: `docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md` §2, §5.

## Global Constraints

- Puente: JavaScript plano ESM, Node 22, **cero dependencias de producción** (fetch nativo). Jamás crashea: todo error se loguea y el loop sigue (regla "nunca silencio" + resiliencia).
- Tipos normalizados del puente (exactos, matchean el enum de `evidence.type`): `comando`, `texto`, `foto`, `audio`, `video`. Documentos por mime (image/→foto, audio/→audio, video/→video; otros se ignoran). Voice notes → `audio` con filename `nota-de-voz.ogg`. De las fotos se toma la resolución más alta (`msg.photo` último elemento).
- n8n: workflow **generado desde código** (`n8n/src/*.js` + `n8n/build-workflow.mjs` → `n8n/workflow.json`), nunca editado a mano. Nodos HTTP con `onError: 'continueRegularOutput'` y todo camino termina en un mensaje (spec §5). 403 de la core-api → silencio administrativo (no responder).
- Respuestas del bot en español. Env vars: `TELEGRAM_BOT_TOKEN`, `N8N_WEBHOOK_URL` (puente), `CORE_API_URL`, `TELEGRAM_BOT_TOKEN` (n8n vía compose).
- Tests sin red: fetch inyectable en el puente; nodos Code testeados con arnés que simula `$json`/`$('Nodo')`. Los tests viven en `core-api/tests/` (un solo runner vitest) e importan por ruta relativa.
- En git no vive ningún secreto. TDD. Branch: `claude/nuevo-proyecto-dxakbn`.
- Verificación end-to-end real (bot vivo + n8n import + compose en la Mac mini) queda EXPLÍCITAMENTE para el testeo manual del usuario — este plan entrega el software y la guía paso a paso.

## File Structure

```
core-api/src/routes/evidence.js     # (modif) POST responde detalle
puente-telegram/
  package.json                      # sin deps; solo metadata + start
  Dockerfile
  src/mapper.js                     # update Telegram → payload normalizado (puro)
  src/bridge.js                     # config, fetchUpdates, downloadFile, forwardUpdate, runOnce
  src/server.js                     # loop infinito resiliente
n8n/
  src/01-preparar-evidencia.js      # Code node: payload puente → evidencePost | ayuda
  src/02-armar-respuesta.js         # Code node: respuesta core-api → texto del bot | silencio
  build-workflow.mjs                # genera workflow.json (patrón HSE)
  workflow.json                     # generado, se commitea (importable en n8n)
core-api/tests/
  evidence-detalle.test.js
  bridge-mapper.test.js
  bridge.test.js
  n8n-harness.js                    # arnés para nodos Code
  n8n-nodes.test.js
  n8n-workflow.test.js
docker-compose.yml                  # (modif) + n8n + puente-telegram
.env.example                        # (modif) TELEGRAM_BOT_TOKEN
README.md                           # (modif) setup completo Mac mini
```

---

### Task 1: POST /api/evidence responde `detalle`

**Files:**
- Modify: `core-api/src/routes/evidence.js`
- Test: `core-api/tests/evidence-detalle.test.js`

**Interfaces:**
- Produces: `POST /api/evidence` → 201 `{id, folio, processed, detalle: {transcription, vision_description, entities: [{kind,name}]}}` — `detalle` refleja la fila YA procesada (post-pipeline). n8n arma el eco con esto sin llamadas extra.

- [ ] **Step 1: Test que falla**

`core-api/tests/evidence-detalle.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'
import { ADMIN_CHAT } from './helpers.js'

function makeAiApp(fetchImpl) {
  process.env.MASTER_KEY = 'ab'.repeat(32)
  process.env.ADMIN_CHAT_ID = ADMIN_CHAT
  process.env.ADMIN_NAME = 'Juan Pablo'
  process.env.GROQ_API_KEY = 'gsk-test'
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-det-'))
  process.env.MEDIA_DIR = path.join(dir, 'media')
  const db = openDb({ dbPath: path.join(dir, 'test.db') })
  return { app: createApp(db, { aiFetch: fetchImpl }), db }
}

const aiOk = async (url, opts) => {
  if (url.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'probamos SkyTrace' }) }
  const body = JSON.parse(opts.body)
  const isVision = JSON.stringify(body.messages).includes('image_url')
  const content = isVision ? 'foto del dron' : JSON.stringify({ entidades: [{ kind: 'empresa', name: 'SkyTrace' }] })
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

describe('detalle en POST /api/evidence', () => {
  it('incluye transcripción y entidades procesadas', async () => {
    const { app } = makeAiApp(aiOk)
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'audio', filename: 'n.ogg', content_base64: Buffer.from('a').toString('base64') })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(true)
    expect(res.body.detalle.transcription).toBe('probamos SkyTrace')
    expect(res.body.detalle.entities).toEqual([{ kind: 'empresa', name: 'SkyTrace' }])
  })

  it('con IA caída el detalle viene con nulls y processed false', async () => {
    const { app } = makeAiApp(async () => ({ ok: false, status: 503, text: async () => 'down' }))
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'hola' })
    expect(res.status).toBe(201)
    expect(res.body.processed).toBe(false)
    expect(res.body.detalle).toEqual({ transcription: null, vision_description: null, entities: [] })
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/evidence-detalle.test.js`
Expected: FAIL — `detalle` undefined

- [ ] **Step 3: Implementar**

En `core-api/src/routes/evidence.js`, en el POST, reemplazar la respuesta 201 por:

```js
    const id = info.lastInsertRowid
    const result = await processEvidence(db, id, { fetchImpl: req.app.locals.aiFetch })
    const fila = db.prepare('SELECT transcription, vision_description FROM evidence WHERE id = ?').get(id)
    const entities = db.prepare(`
      SELECT e.kind, e.name FROM entity_mentions m
      JOIN entities e ON e.id = m.entity_id
      WHERE m.evidence_id = ? ORDER BY e.id
    `).all(id)
    res.status(201).json({
      id,
      folio: `E-${String(id).padStart(4, '0')}`,
      processed: result.processed,
      detalle: {
        transcription: fila.transcription,
        vision_description: fila.vision_description,
        entities,
      },
    })
```

(La query de entidades ya existe idéntica en el GET /:id — dejarla duplicada está bien por ahora; si el implementador prefiere, extraer un helper `entitiesFor(db, evidenceId)` local al archivo y usarlo en ambos.)

- [ ] **Step 4: Suite completa**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites (los tests previos de POST siguen pasando: `detalle` es aditivo)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/routes/evidence.js core-api/tests/evidence-detalle.test.js
git commit -m "feat(core-api): POST de evidencia responde detalle procesado para el bot"
```

---

### Task 2: Mapper del puente (update Telegram → payload normalizado)

**Files:**
- Create: `puente-telegram/src/mapper.js`
- Test: `core-api/tests/bridge-mapper.test.js`

**Interfaces:**
- Produces: `mapUpdate(update) → null | {chatId, tipo, texto?, comando?, fileId?, filename?, caption?}` — tipos exactos `comando|texto|foto|audio|video`; `null` = ignorar (stickers, ubicaciones, etc.).

- [ ] **Step 1: Test que falla**

`core-api/tests/bridge-mapper.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mapUpdate } from '../../puente-telegram/src/mapper.js'

const base = { update_id: 1 }
const chat = { id: 5551234 }

describe('mapper del puente', () => {
  it('texto plano', () => {
    expect(mapUpdate({ ...base, message: { chat, text: 'probamos el sensor' } }))
      .toEqual({ chatId: '5551234', tipo: 'texto', texto: 'probamos el sensor' })
  })

  it('comando', () => {
    expect(mapUpdate({ ...base, message: { chat, text: '/start hola' } }))
      .toEqual({ chatId: '5551234', tipo: 'comando', comando: '/start', texto: '/start hola' })
  })

  it('nota de voz → audio', () => {
    expect(mapUpdate({ ...base, message: { chat, voice: { file_id: 'F1' } } }))
      .toEqual({ chatId: '5551234', tipo: 'audio', fileId: 'F1', filename: 'nota-de-voz.ogg', caption: null })
  })

  it('foto: toma la resolución más alta y conserva caption', () => {
    const message = { chat, caption: 'banco de pruebas', photo: [{ file_id: 'chica' }, { file_id: 'grande' }] }
    expect(mapUpdate({ ...base, message }))
      .toEqual({ chatId: '5551234', tipo: 'foto', fileId: 'grande', filename: 'foto.jpg', caption: 'banco de pruebas' })
  })

  it('video con nombre', () => {
    const message = { chat, video: { file_id: 'V1', file_name: 'vuelo.mp4' } }
    expect(mapUpdate({ ...base, message })).toMatchObject({ tipo: 'video', fileId: 'V1', filename: 'vuelo.mp4' })
  })

  it('documento por mime: imagen → foto; desconocido → null', () => {
    expect(mapUpdate({ ...base, message: { chat, document: { file_id: 'D1', mime_type: 'image/png', file_name: 'plano.png' } } }))
      .toMatchObject({ tipo: 'foto', filename: 'plano.png' })
    expect(mapUpdate({ ...base, message: { chat, document: { file_id: 'D2', mime_type: 'application/zip' } } })).toBeNull()
  })

  it('updates sin mensaje o no soportados → null', () => {
    expect(mapUpdate({ ...base })).toBeNull()
    expect(mapUpdate({ ...base, message: { chat, sticker: { file_id: 'S1' } } })).toBeNull()
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/bridge-mapper.test.js`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar**

`puente-telegram/src/mapper.js`:

```js
export function mapUpdate(update) {
  const msg = update.message
  if (!msg || !msg.chat) return null
  const chatId = String(msg.chat.id)
  const caption = msg.caption || null

  if (typeof msg.text === 'string') {
    if (msg.text.startsWith('/')) {
      return { chatId, tipo: 'comando', comando: msg.text.split(/\s+/)[0], texto: msg.text }
    }
    return { chatId, tipo: 'texto', texto: msg.text }
  }
  if (msg.voice) return { chatId, tipo: 'audio', fileId: msg.voice.file_id, filename: 'nota-de-voz.ogg', caption }
  if (msg.audio) return { chatId, tipo: 'audio', fileId: msg.audio.file_id, filename: msg.audio.file_name || 'audio.mp3', caption }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1]
    return { chatId, tipo: 'foto', fileId: best.file_id, filename: 'foto.jpg', caption }
  }
  if (msg.video) return { chatId, tipo: 'video', fileId: msg.video.file_id, filename: msg.video.file_name || 'video.mp4', caption }
  if (msg.document) {
    const mime = msg.document.mime_type || ''
    const tipo = mime.startsWith('image/') ? 'foto'
      : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('video/') ? 'video'
      : null
    if (!tipo) return null
    return { chatId, tipo, fileId: msg.document.file_id, filename: msg.document.file_name || 'archivo.bin', caption }
  }
  return null
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/bridge-mapper.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add puente-telegram/src/mapper.js core-api/tests/bridge-mapper.test.js
git commit -m "feat(puente): mapper de updates de Telegram a payload normalizado"
```

---

### Task 3: Núcleo del puente (polling, descarga, reenvío) + servicio

**Files:**
- Create: `puente-telegram/src/bridge.js`
- Create: `puente-telegram/src/server.js`
- Create: `puente-telegram/package.json`
- Create: `puente-telegram/Dockerfile`
- Create: `puente-telegram/.dockerignore`
- Test: `core-api/tests/bridge.test.js`

**Interfaces:**
- Consumes: `mapUpdate` (Task 2).
- Produces:
  - `config(env?) → {token, webhook}` (lanza si faltan `TELEGRAM_BOT_TOKEN`/`N8N_WEBHOOK_URL`)
  - `fetchUpdates(offset, {token, fetchImpl}) → updates[]`
  - `downloadFile(fileId, {token, fetchImpl}) → Buffer`
  - `forwardUpdate(update, deps) → {forwarded, reason?}` (descarga media, agrega `content_base64`, POST al webhook)
  - `runOnce(offset, deps) → nuevoOffset` — un update que falla se loguea y NO corta el batch.

- [ ] **Step 1: Test que falla**

`core-api/tests/bridge.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { config, fetchUpdates, downloadFile, forwardUpdate, runOnce } from '../../puente-telegram/src/bridge.js'

const deps = (fetchImpl, log = { error: () => {} }) =>
  ({ token: 'TOK', webhook: 'http://n8n:5678/webhook/telegram', fetchImpl, log })

describe('puente-telegram', () => {
  it('config exige las dos env vars', () => {
    expect(() => config({})).toThrow(/TELEGRAM_BOT_TOKEN/)
    expect(config({ TELEGRAM_BOT_TOKEN: 't', N8N_WEBHOOK_URL: 'w' })).toEqual({ token: 't', webhook: 'w' })
  })

  it('fetchUpdates pega a getUpdates con offset y timeout', async () => {
    let url
    const f = async (u) => { url = u; return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 7 }] }) } }
    const res = await fetchUpdates(5, deps(f))
    expect(url).toBe('https://api.telegram.org/botTOK/getUpdates?timeout=25&offset=5')
    expect(res).toEqual([{ update_id: 7 }])
  })

  it('downloadFile resuelve getFile y baja el binario', async () => {
    const calls = []
    const f = async (u) => {
      calls.push(u)
      if (u.includes('getFile')) return { ok: true, json: async () => ({ result: { file_path: 'voice/f.ogg' } }) }
      return { ok: true, arrayBuffer: async () => Buffer.from('binario') }
    }
    const buf = await downloadFile('F1', deps(f))
    expect(calls[1]).toBe('https://api.telegram.org/file/botTOK/voice/f.ogg')
    expect(buf.toString()).toBe('binario')
  })

  it('forwardUpdate arma el payload con content_base64 y postea al webhook', async () => {
    let posted
    const f = async (u, opts) => {
      if (u.includes('getFile')) return { ok: true, json: async () => ({ result: { file_path: 'p/f.ogg' } }) }
      if (u.includes('/file/')) return { ok: true, arrayBuffer: async () => Buffer.from('audio') }
      posted = { url: u, body: JSON.parse(opts.body) }
      return { ok: true }
    }
    const update = { update_id: 1, message: { chat: { id: 9 }, voice: { file_id: 'F1' } } }
    const res = await forwardUpdate(update, deps(f))
    expect(res.forwarded).toBe(true)
    expect(posted.url).toBe('http://n8n:5678/webhook/telegram')
    expect(posted.body).toMatchObject({ chatId: '9', tipo: 'audio', filename: 'nota-de-voz.ogg' })
    expect(posted.body.content_base64).toBe(Buffer.from('audio').toString('base64'))
    expect(posted.body.fileId).toBeUndefined()
  })

  it('update no mapeable no se reenvía', async () => {
    const res = await forwardUpdate({ update_id: 2 }, deps(async () => { throw new Error('no debería llamar') }))
    expect(res).toEqual({ forwarded: false, reason: 'sin_mapeo' })
  })

  it('runOnce avanza el offset y un update fallido no corta el batch', async () => {
    const errors = []
    const f = async (u, opts) => {
      if (u.includes('getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 10, message: { chat: { id: 1 }, text: 'falla' } },
        { update_id: 11, message: { chat: { id: 1 }, text: 'anda' } },
      ] }) }
      const body = JSON.parse(opts.body)
      if (body.texto === 'falla') return { ok: false, status: 500 }
      return { ok: true }
    }
    const next = await runOnce(3, deps(f, { error: (m) => errors.push(m) }))
    expect(next).toBe(12)
    expect(errors).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/bridge.test.js`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar**

`puente-telegram/src/bridge.js`:

```js
import { mapUpdate } from './mapper.js'

const api = (token) => `https://api.telegram.org/bot${token}`
const files = (token) => `https://api.telegram.org/file/bot${token}`

export function config(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN
  const webhook = env.N8N_WEBHOOK_URL
  if (!token || !webhook) throw new Error('faltan TELEGRAM_BOT_TOKEN o N8N_WEBHOOK_URL')
  return { token, webhook }
}

export async function fetchUpdates(offset, { token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${api(token)}/getUpdates?timeout=25&offset=${offset}`)
  if (!res.ok) throw new Error(`getUpdates respondió ${res.status}`)
  const data = await res.json()
  if (!data.ok) throw new Error('getUpdates devolvió ok=false')
  return data.result
}

export async function downloadFile(fileId, { token, fetchImpl = fetch }) {
  const meta = await fetchImpl(`${api(token)}/getFile?file_id=${fileId}`)
  if (!meta.ok) throw new Error(`getFile respondió ${meta.status}`)
  const info = await meta.json()
  const bin = await fetchImpl(`${files(token)}/${info.result.file_path}`)
  if (!bin.ok) throw new Error(`descarga de archivo respondió ${bin.status}`)
  return Buffer.from(await bin.arrayBuffer())
}

export async function forwardUpdate(update, deps) {
  const { webhook, fetchImpl = fetch } = deps
  const mapped = mapUpdate(update)
  if (!mapped) return { forwarded: false, reason: 'sin_mapeo' }
  const payload = { ...mapped }
  if (mapped.fileId) {
    const buffer = await downloadFile(mapped.fileId, deps)
    payload.content_base64 = buffer.toString('base64')
    delete payload.fileId
  }
  const res = await fetchImpl(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`webhook respondió ${res.status}`)
  return { forwarded: true }
}

export async function runOnce(offset, deps) {
  const log = deps.log || console
  const updates = await fetchUpdates(offset, deps)
  let next = offset
  for (const u of updates) {
    next = Math.max(next, u.update_id + 1)
    try {
      await forwardUpdate(u, deps)
    } catch (err) {
      log.error(`puente: update ${u.update_id} falló: ${err}`)
    }
  }
  return next
}
```

`puente-telegram/src/server.js`:

```js
import { config, runOnce } from './bridge.js'

const deps = config()
let offset = 0
console.log('puente-telegram escuchando (long polling, sin puertos expuestos)')

while (true) {
  try {
    offset = await runOnce(offset, deps)
  } catch (err) {
    console.error(`puente: ciclo falló: ${err} — reintento en 5s`)
    await new Promise((r) => setTimeout(r, 5000))
  }
}
```

`puente-telegram/package.json`:

```json
{
  "name": "pbos-puente-telegram",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/server.js" }
}
```

`puente-telegram/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
```

`puente-telegram/.dockerignore`:

```
node_modules
```

- [ ] **Step 4: Suite completa**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites

- [ ] **Step 5: Commit**

```bash
git add puente-telegram/ core-api/tests/bridge.test.js
git commit -m "feat(puente): long polling resiliente que reenvia updates normalizados a n8n"
```

---

### Task 4: Nodos Code de n8n + arnés de tests

**Files:**
- Create: `n8n/src/01-preparar-evidencia.js`
- Create: `n8n/src/02-armar-respuesta.js`
- Create: `core-api/tests/n8n-harness.js`
- Test: `core-api/tests/n8n-nodes.test.js`

**Interfaces:**
- Produces: dos archivos de código de nodo (formato n8n Code v2: terminan con `return [...]` de items `{json}`), y `runCodeNode(codePath, {json, nodes}) → items` para testearlos.
- Contratos de los nodos:
  - `01`: entrada = payload del puente (en `$json.body`); salida `{chatId, esComando: true, texto: AYUDA}` para comandos, `{chatId, esComando: false, evidencePost: {type, text, filename, content_base64, context}}` para evidencia.
  - `02`: entrada = respuesta full de la HTTP (statusCode/body) con `$('Preparar evidencia')` accesible; salida `{responder: false, chatId}` si 403; `{responder: true, chatId, texto}` con eco (folio + 🎙️ transcripción + 🖼 visión + 🏷 entidades + aviso si !processed) o fallback amable si error.

- [ ] **Step 1: Escribir el arnés**

`core-api/tests/n8n-harness.js`:

```js
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Ejecuta un nodo Code de n8n simulando $json / $('Nodo') / $input. */
export function runCodeNode(file, { json = {}, nodes = {} } = {}) {
  const code = readFileSync(path.join(HERE, '../../n8n/src', file), 'utf8')
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`nodo no simulado: ${name}`)
    return { first: () => ({ json: nodes[name] }) }
  }
  const $input = { all: () => [{ json }], first: () => ({ json }) }
  const fn = new Function('$json', '$', '$input', code)
  return fn(json, $, $input)
}
```

- [ ] **Step 2: Test que falla**

`core-api/tests/n8n-nodes.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { runCodeNode } from './n8n-harness.js'

describe('nodo 01: preparar evidencia', () => {
  it('comando → ayuda', () => {
    const [out] = runCodeNode('01-preparar-evidencia.js', {
      json: { body: { chatId: '9', tipo: 'comando', comando: '/start', texto: '/start' } },
    })
    expect(out.json.esComando).toBe(true)
    expect(out.json.chatId).toBe('9')
    expect(out.json.texto).toMatch(/Personal Brand OS/)
  })

  it('audio → evidencePost completo', () => {
    const [out] = runCodeNode('01-preparar-evidencia.js', {
      json: { body: { chatId: '9', tipo: 'audio', filename: 'nota-de-voz.ogg', content_base64: 'QUJD', caption: 'en obra' } },
    })
    expect(out.json.esComando).toBe(false)
    expect(out.json.evidencePost).toEqual({
      type: 'audio',
      text: null,
      filename: 'nota-de-voz.ogg',
      content_base64: 'QUJD',
      context: { origen: 'telegram', caption: 'en obra' },
    })
  })

  it('texto → evidencePost con text', () => {
    const [out] = runCodeNode('01-preparar-evidencia.js', {
      json: { body: { chatId: '9', tipo: 'texto', texto: 'probamos el sensor' } },
    })
    expect(out.json.evidencePost.type).toBe('texto')
    expect(out.json.evidencePost.text).toBe('probamos el sensor')
  })
})

describe('nodo 02: armar respuesta', () => {
  const nodes = { 'Preparar evidencia': { chatId: '9' } }

  it('201 con detalle → eco completo', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: {
        statusCode: 201,
        body: {
          folio: 'E-0042', processed: true,
          detalle: {
            transcription: 'probamos SkyTrace',
            vision_description: null,
            entities: [{ kind: 'empresa', name: 'SkyTrace' }],
          },
        },
      },
      nodes,
    })
    expect(out.json.responder).toBe(true)
    expect(out.json.texto).toContain('E-0042')
    expect(out.json.texto).toContain('probamos SkyTrace')
    expect(out.json.texto).toContain('SkyTrace')
  })

  it('403 → silencio administrativo', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', { json: { statusCode: 403, body: {} }, nodes })
    expect(out.json.responder).toBe(false)
  })

  it('error de la API → fallback amable que no pierde la captura', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', { json: { error: 'ECONNREFUSED' }, nodes })
    expect(out.json.responder).toBe(true)
    expect(out.json.texto).toMatch(/no pude guardar/i)
  })

  it('processed false → avisa que procesa más tarde', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 201, body: { folio: 'E-0001', processed: false, detalle: { transcription: null, vision_description: null, entities: [] } } },
      nodes,
    })
    expect(out.json.texto).toContain('E-0001')
    expect(out.json.texto).toMatch(/más tarde/)
  })
})
```

- [ ] **Step 3: Verificar que falla**

Run: `cd core-api && npx vitest run tests/n8n-nodes.test.js`
Expected: FAIL — archivos de nodo inexistentes

- [ ] **Step 4: Implementar los nodos**

`n8n/src/01-preparar-evidencia.js`:

```js
// Entrada: POST del puente-telegram — $json.body = {chatId, tipo, texto?, comando?, caption?, filename?, content_base64?}
const b = $json.body || $json

const AYUDA = [
  '👋 Soy tu Personal Brand OS.',
  'Mandame fotos, audios, videos o texto con tus avances personales y laborales, y los archivo como evidencia procesada (transcripción, descripción y entidades).',
  '',
  'Comandos: /start — esta ayuda',
].join('\n')

if (b.tipo === 'comando') {
  return [{ json: { chatId: b.chatId, esComando: true, texto: AYUDA } }]
}

const evidencePost = {
  type: b.tipo,
  text: b.texto || null,
  filename: b.filename || null,
  content_base64: b.content_base64 || null,
  context: { origen: 'telegram', caption: b.caption || null },
}
return [{ json: { chatId: b.chatId, esComando: false, evidencePost } }]
```

`n8n/src/02-armar-respuesta.js`:

```js
// Entrada: respuesta full de "Persistir evidencia" ({statusCode, body} o {error})
const r = $json
const chatId = $('Preparar evidencia').first().json.chatId
const status = r.statusCode
const body = r.body || {}

if (status === 403) {
  // silencio administrativo: remitente no autorizado
  return [{ json: { responder: false, chatId } }]
}

if (status !== 201 || !body.folio) {
  return [{ json: {
    responder: true,
    chatId,
    texto: '⚠️ Ahora mismo no pude guardar tu evidencia. No la perdiste: mandala de nuevo en unos minutos.',
  } }]
}

const det = body.detalle || {}
const lineas = [`📎 Evidencia ${body.folio} guardada.`]
if (det.transcription) lineas.push(`🎙️ Escuché: «${det.transcription}»`)
if (det.vision_description) lineas.push(`🖼 Veo: ${det.vision_description}`)
if (Array.isArray(det.entities) && det.entities.length) {
  lineas.push('🏷 ' + det.entities.map((e) => e.name).join(', '))
}
if (!body.processed) lineas.push('⏳ La proceso más tarde (la IA no respondió).')

return [{ json: { responder: true, chatId, texto: lineas.join('\n') } }]
```

- [ ] **Step 5: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/n8n-nodes.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add n8n/src/ core-api/tests/n8n-harness.js core-api/tests/n8n-nodes.test.js
git commit -m "feat(n8n): nodos de preparacion y respuesta con arnes de tests"
```

---

### Task 5: Generador del workflow n8n

**Files:**
- Create: `n8n/build-workflow.mjs`
- Create: `n8n/workflow.json` (generado por el build, se commitea)
- Test: `core-api/tests/n8n-workflow.test.js`

**Interfaces:**
- Produces: `node n8n/build-workflow.mjs` regenera `n8n/workflow.json` importable. Flujo: `Webhook Telegram → ACK → Preparar evidencia → ¿Es comando? → (sí) Enviar por Telegram / (no) Persistir evidencia → Armar respuesta → ¿Responder? → (sí) Enviar por Telegram`.

- [ ] **Step 1: Test que falla**

`core-api/tests/n8n-workflow.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('workflow de n8n', () => {
  it('el build genera un workflow válido y consistente', () => {
    execFileSync('node', [path.join(ROOT, 'n8n/build-workflow.mjs')])
    const wf = JSON.parse(readFileSync(path.join(ROOT, 'n8n/workflow.json'), 'utf8'))
    const names = wf.nodes.map((n) => n.name)
    for (const esperado of ['Webhook Telegram', 'ACK', 'Preparar evidencia', '¿Es comando?',
      'Persistir evidencia', 'Armar respuesta', '¿Responder?', 'Enviar por Telegram']) {
      expect(names, `falta el nodo ${esperado}`).toContain(esperado)
    }
    // toda conexión apunta a un nodo existente
    for (const [from, conf] of Object.entries(wf.connections)) {
      expect(names).toContain(from)
      for (const salidas of conf.main) {
        for (const destino of salidas || []) expect(names).toContain(destino.node)
      }
    }
    // el código de los nodos Code es el de src/ (fuente única)
    const prep = wf.nodes.find((n) => n.name === 'Preparar evidencia')
    expect(prep.parameters.jsCode).toContain('Personal Brand OS')
    const resp = wf.nodes.find((n) => n.name === 'Armar respuesta')
    expect(resp.parameters.jsCode).toContain('silencio administrativo')
    // la persistencia manda el header de identidad y trae fullResponse
    const persistir = wf.nodes.find((n) => n.name === 'Persistir evidencia')
    expect(JSON.stringify(persistir.parameters)).toContain('X-Telegram-Chat-Id')
    expect(persistir.parameters.options.response.response.fullResponse).toBe(true)
    expect(persistir.onError).toBe('continueRegularOutput')
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/n8n-workflow.test.js`
Expected: FAIL — build-workflow.mjs inexistente

- [ ] **Step 3: Implementar el generador**

`n8n/build-workflow.mjs`:

```js
// Genera n8n/workflow.json (importable en n8n) desde n8n/src/*.js — nunca editar workflow.json a mano.
// Uso: node n8n/build-workflow.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const src = (f) => readFileSync(join(dir, 'src', f), 'utf8').trim()

const codeNode = (name, file, position) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
  parameters: { jsCode: src(file) },
})

const ifNode = (name, leftExpr, position) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2,
  position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        leftValue: leftExpr,
        rightValue: 'true',
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
})

const nodes = [
  {
    name: 'Webhook Telegram',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, 300],
    webhookId: 'pbos-telegram',
    parameters: { httpMethod: 'POST', path: 'telegram', responseMode: 'responseNode', options: {} },
  },
  {
    // ACK inmediato al puente: la respuesta real sale por sendMessage (nunca silencio por latencia)
    name: 'ACK',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [180, 300],
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ok: true}) }}', options: {} },
  },
  codeNode('Preparar evidencia', '01-preparar-evidencia.js', [360, 300]),
  ifNode('¿Es comando?', '={{ $json.esComando }}', [540, 300]),
  {
    name: 'Persistir evidencia',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [760, 380],
    onError: 'continueRegularOutput', // si la core-api falla, "Armar respuesta" contesta el fallback
    parameters: {
      method: 'POST',
      url: '={{ $env.CORE_API_URL }}/api/evidence',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'X-Telegram-Chat-Id', value: '={{ $json.chatId }}' },
        { name: 'Content-Type', value: 'application/json' },
      ] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.evidencePost) }}',
      options: {
        timeout: 120000, // el pipeline de IA puede tardar
        response: { response: { fullResponse: true, neverError: false } },
      },
    },
  },
  codeNode('Armar respuesta', '02-armar-respuesta.js', [980, 380]),
  ifNode('¿Responder?', '={{ $json.responder }}', [1160, 380]),
  {
    name: 'Enviar por Telegram',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1380, 300],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: '=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ chat_id: $json.chatId, text: $json.texto }) }}',
      options: { timeout: 30000 },
    },
  },
].map((n, i) => ({ id: `pbos-${String(i + 1).padStart(2, '0')}`, ...n }))

const main = (node, outputIndex = 0) => ({ node, type: 'main', index: 0, _out: outputIndex })
const connect = (pairs) => Object.fromEntries(pairs.map(([from, tos]) => {
  const byOutput = []
  for (const t of tos) {
    const out = t._out || 0
    byOutput[out] = byOutput[out] || []
    byOutput[out].push({ node: t.node, type: 'main', index: 0 })
  }
  for (let i = 0; i < byOutput.length; i++) byOutput[i] = byOutput[i] || []
  return [from, { main: byOutput }]
}))

const connections = connect([
  ['Webhook Telegram', [main('ACK')]],
  ['ACK', [main('Preparar evidencia')]],
  ['Preparar evidencia', [main('¿Es comando?')]],
  ['¿Es comando?', [
    { ...main('Enviar por Telegram'), _out: 0 },   // true: la ayuda va directo al chat
    { ...main('Persistir evidencia'), _out: 1 },   // false: flujo de evidencia
  ]],
  ['Persistir evidencia', [main('Armar respuesta')]],
  ['Armar respuesta', [main('¿Responder?')]],
  ['¿Responder?', [
    { ...main('Enviar por Telegram'), _out: 0 },   // true
    // false (403): no se conecta nada — silencio administrativo
  ]],
])

const workflow = {
  id: 'pbos-telegram',
  name: 'Personal Brand OS — Captura Telegram',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
  active: false,
  pinData: {},
}

const out = join(dir, 'workflow.json')
writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n')
console.log(`OK -> ${out} (${nodes.length} nodos)`)
```

- [ ] **Step 4: Generar y verificar**

Run: `node n8n/build-workflow.mjs && cd core-api && npx vitest run`
Expected: `OK -> .../workflow.json (8 nodos)` y suite completa PASS

- [ ] **Step 5: Commit**

```bash
git add n8n/build-workflow.mjs n8n/workflow.json core-api/tests/n8n-workflow.test.js
git commit -m "feat(n8n): workflow de captura generado desde codigo versionado"
```

---

### Task 6: Compose, env y guía de la Mac mini

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `docker compose up -d --build` levanta core-api + n8n + puente-telegram. Guía paso a paso para el testeo manual del usuario.

- [ ] **Step 1: Ampliar docker-compose.yml**

Reemplazar el contenido completo por:

```yaml
services:
  core-api:
    build: ./core-api
    env_file: .env
    environment:
      - DB_PATH=/data/pbos.db
      - MEDIA_DIR=/data/media
    volumes:
      - pbos_data:/data
    ports:
      - "3000:3000"
    restart: unless-stopped

  n8n:
    image: n8nio/n8n:latest
    environment:
      - CORE_API_URL=http://core-api:3000
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - GROQ_API_KEY=${GROQ_API_KEY}
      - N8N_DIAGNOSTICS_ENABLED=false
      - N8N_SECURE_COOKIE=false
    ports:
      - "5678:5678"
    volumes:
      - n8n_data:/home/node/.n8n
    restart: unless-stopped
    depends_on:
      - core-api

  puente-telegram:
    build: ./puente-telegram
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - N8N_WEBHOOK_URL=http://n8n:5678/webhook/telegram
    restart: unless-stopped
    depends_on:
      - n8n

volumes:
  pbos_data:
  n8n_data:
```

- [ ] **Step 2: Ampliar .env.example**

Reemplazar la línea comentada `# TELEGRAM_BOT_TOKEN=   (Plan B2)` por:

```bash
# Bot de Telegram (Plan B2) — crearlo con @BotFather y pegar el token acá
TELEGRAM_BOT_TOKEN=
```

- [ ] **Step 3: Actualizar README**

1. Cambiar la línea de estado por: `- **Estado:** Plan B2 (captura por Telegram) — ver \`docs/superpowers/plans/\``
2. Agregar al final del README:

```markdown
## Captura por Telegram (Plan B2)

Flujo: **Telegram → puente (long polling) → n8n → core-api (IA) → respuesta del bot.**
La Mac mini no expone ningún puerto a Internet: el puente sale a buscar los mensajes.

### Setup (una sola vez)

1. **Crear el bot:** hablarle a [@BotFather](https://t.me/BotFather) → `/newbot` → copiar el
   token a `TELEGRAM_BOT_TOKEN` en `.env`.
2. **Tu chat ID:** mandarle un mensaje a [@userinfobot](https://t.me/userinfobot) y copiar el
   `Id` a `ADMIN_CHAT_ID` en `.env` (es el que autoriza tu usuario; cualquier otro remitente
   recibe silencio).
3. **Levantar todo:** `docker compose up -d --build`
4. **Importar el workflow en n8n (primera vez):** abrir [http://localhost:5678](http://localhost:5678),
   crear el usuario local, *Workflows → Import from file* → `n8n/workflow.json` → activarlo
   (toggle **Active**).
   El workflow se genera desde código: si se toca algo en `n8n/src/`, regenerar con
   `node n8n/build-workflow.mjs` y re-importar.

### Probar

1. `/start` al bot → responde la ayuda.
2. Mandar una nota de voz → `📎 Evidencia E-0001 guardada. 🎙️ Escuché: «...»`.
3. Mandar una foto con caption → descripción de visión + entidades detectadas.
4. Desde otro Telegram (no autorizado) → silencio absoluto.
```

- [ ] **Step 4: Suite completa una vez más**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example README.md
git commit -m "feat: orquestacion completa de captura (compose + guia Mac mini)"
```

---

## Self-Review del plan (ejecutada)

1. **Cobertura vs spec:** cubre spec §2 (puente long polling sin exponer puertos, n8n orquesta sin pensar ni persistir, core-api dueña del cerebro), §5 (nunca silencio: ACK + respuesta asíncrona; todo camino termina en mensaje; fallback amable; silencio administrativo para no autorizados; captura nunca se pierde). No cubre (asignado): sesiones/conversación → Plan C; comandos /cola /idea /marca → Planes C/E.
2. **Placeholders:** ninguno.
3. **Consistencia:** payload del puente `{chatId, tipo, texto?, comando?, caption?, filename?, content_base64?}` idéntico entre mapper (T2), bridge (T3), nodo 01 (T4); `evidencePost` idéntico al contrato de `POST /api/evidence` (Plan A/B1 + detalle de T1); nombres de nodos idénticos entre build (T5) y test.
4. **Limitación explícita:** la validación contra n8n real y Telegram real es el testeo manual del usuario (documentado en T6) — este plan garantiza lógica testeada y artefactos generados.
