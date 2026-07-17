# Plan C1 — Cerebro conversacional (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar en la core-api el flujo editorial completo detrás de `POST /api/agent/next-turn`: evidencia → propuesta de idea → elección de perfiles → boceto por perfil (con la voz de cada marca) → refinamiento conversacional → aprobación → versiones por canal con imagen procesada y programación. Todo testeable sin red ni Telegram (la integración Telegram/n8n es el Plan C2).

**Architecture:** La máquina de estados vive en `src/agent/` (determinística, testeable); el LLM solo redacta (proponer idea, redactar boceto con la identidad del perfil, refinar con feedback, adaptar por canal) vía `chat('redactar')` con prompts versionados. Sharp procesa la imagen con plantilla de marca. n8n (C2) solo llamará `next-turn` y renderizará `{texto, botones}`.

**Tech Stack:** Node 22 ESM · sharp (única dependencia nueva) · Groq vía capa B1 · Vitest.

**Plan series:** A ✅ · B1 ✅ · B2 ✅ · **C1 (este)** · C2 (integración Telegram) · D · E. Spec: §4.8-4.10, §5, §6.

## Global Constraints

- Estados de sesión exactos (spec §5): `inicio` → `proponiendo_idea` → `eligiendo_perfiles` → `refinando_boceto` → `programando` → `inicio`. Sesión con TTL 2 h en la tabla `sessions` (keyed user+chat).
- Contrato de `POST /api/agent/next-turn` (C2 lo consume tal cual):
  - Request: `{ input: { clase: 'evidencia'|'texto'|'boton'|'comando', evidencia?: {id, folio, processed, detalle}, texto?, boton?, comando? } }` + header de identidad.
  - Response: `{ texto, botones: [{id, label}] | [], estado }` — SIEMPRE hay `texto` (nunca silencio).
- Botones con ids exactos (C2 los mapea a callback_data): `idea_desarrollar`, `idea_guardar`, `idea_descartar`, `perfil_<id>`, `perfil_ambas`, `boceto_aprobar`, `boceto_otra`, `boceto_descartar`, `prog_ahora`, `prog_maniana`, `prog_cola`.
- El LLM jamás decide transiciones: solo genera texto. Toda transición es código. Regla de oro B1 aplica: si el LLM falla, `next-turn` responde un fallback amable y NO rompe la sesión.
- Identidad del perfil inyectada al redactar: name + identity_json completo (spec §4.3). raw_llm_json auditado en drafts/ideas.
- Estados de datos exactos del schema (Plan A): ideas `capturada|en_conversacion|lista|descartada`; drafts `en_refinamiento|aprobado|descartado`; channel_versions `pendiente|aprobada|programada|publicada|entregada_manual|cancelada`.
- Programación: `prog_ahora` → versiones `aprobada` con `scheduled_at` = NULL (el scheduler del Plan D las toma como inmediatas); `prog_maniana` → `programada` con `scheduled_at` mañana 09:00 local; `prog_cola` → quedan `aprobada` sin scheduled_at y NO se despachan (el Plan D solo despacha `programada` vencidas y `aprobada` marcadas inmediatas vía flag `publish_now` en el data_json de la versión... simplificación v1: `prog_ahora` marca `scheduled_at = datetime('now')` y estado `programada`; `prog_cola` deja `aprobada`).
- Formatos v1 propuestos por código simple (spec §6): media foto → linkedin `imagen` + instagram `feed`; solo texto → linkedin `texto` (instagram se omite si no hay imagen); wa_status `historia` si hay imagen. Solo canales del perfil con estado `conectado` en `profile_channels` más `wa_status` siempre (manual).
- Imagen procesada con sharp: cover al aspecto del formato + barra inferior con el nombre de la marca. Dimensiones: linkedin imagen 1200×1350? NO — exactas: linkedin `imagen` 1200×627; instagram `feed` 1080×1350; wa_status/historia 1080×1920.
- Tests sin red (fetch mockeado) y sin Telegram. Español. TDD. Branch `claude/nuevo-proyecto-dxakbn`.

## File Structure

```
core-api/
  prompts/
    proponer-idea.md
    redactar-boceto.md
    adaptar-version.md
  src/
    services/
      sessions.js            # getSession/setSession/clearSession con TTL
      editorial.js           # ideas, drafts, channel_versions (repositorio)
      redactor.js            # proponerIdea / redactarBoceto / refinarBoceto / adaptarVersion (LLM)
      imagen.js              # renderChannelImage (sharp)
    agent/
      next-turn.js           # máquina de estados (corazón)
    routes/agent.js          # POST /api/agent/next-turn
  tests/
    sessions.test.js
    editorial.test.js
    redactor.test.js
    imagen.test.js
    next-turn.test.js
    agent-route.test.js
```

---

### Task 1: Sesiones con TTL

**Files:**
- Create: `core-api/src/services/sessions.js`
- Test: `core-api/tests/sessions.test.js`

**Interfaces:**
- Produces: `getSession(db, userId, chatId) → {state, data} | null` (expira por TTL); `setSession(db, userId, chatId, state, data)` (upsert, TTL 2 h); `clearSession(db, userId, chatId)`.

- [ ] **Step 1: Test que falla**

`core-api/tests/sessions.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { makeTestApp } from './helpers.js'
import { getSession, setSession, clearSession } from '../src/services/sessions.js'

describe('sesiones', () => {
  it('upsert y lectura', () => {
    const { db } = makeTestApp()
    setSession(db, 1, 'c1', 'proponiendo_idea', { ideaId: 7 })
    expect(getSession(db, 1, 'c1')).toEqual({ state: 'proponiendo_idea', data: { ideaId: 7 } })
    setSession(db, 1, 'c1', 'programando', {})
    expect(getSession(db, 1, 'c1').state).toBe('programando')
  })

  it('expirada devuelve null', () => {
    const { db } = makeTestApp()
    setSession(db, 1, 'c1', 'inicio', {})
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 minute')").run()
    expect(getSession(db, 1, 'c1')).toBeNull()
  })

  it('clear borra', () => {
    const { db } = makeTestApp()
    setSession(db, 1, 'c1', 'inicio', {})
    clearSession(db, 1, 'c1')
    expect(getSession(db, 1, 'c1')).toBeNull()
  })
})
```

- [ ] **Step 2: Verificar que falla** — `cd core-api && npx vitest run tests/sessions.test.js` → módulo inexistente

- [ ] **Step 3: Implementar**

`core-api/src/services/sessions.js`:

```js
export function getSession(db, userId, chatId) {
  const row = db.prepare(`
    SELECT state, data_json FROM sessions
    WHERE user_id = ? AND chat_id = ? AND expires_at > datetime('now')
  `).get(userId, String(chatId))
  return row ? { state: row.state, data: JSON.parse(row.data_json) } : null
}

export function setSession(db, userId, chatId, state, data = {}) {
  db.prepare(`
    INSERT INTO sessions (user_id, chat_id, state, data_json, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+2 hours'))
    ON CONFLICT (user_id, chat_id) DO UPDATE SET
      state = excluded.state, data_json = excluded.data_json, expires_at = excluded.expires_at
  `).run(userId, String(chatId), state, JSON.stringify(data))
}

export function clearSession(db, userId, chatId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND chat_id = ?').run(userId, String(chatId))
}
```

- [ ] **Step 4: Suite completa** — PASS
- [ ] **Step 5: Commit** — `git add core-api/src/services/sessions.js core-api/tests/sessions.test.js && git commit -m "feat(core-api): sesiones conversacionales con TTL"`

---

### Task 2: Repositorio editorial (ideas, drafts, versiones)

**Files:**
- Create: `core-api/src/services/editorial.js`
- Test: `core-api/tests/editorial.test.js`

**Interfaces:**
- Produces (todas con `db` primer arg):
  - `createIdea(db, {userId, title, summary, evidenceIds}) → ideaId` (estado `capturada`, vincula `idea_evidence`)
  - `setIdeaStatus(db, ideaId, status)`; `linkIdeaProfiles(db, ideaId, profileIds)`
  - `createDraft(db, {ideaId, profileId, content, rawLlm}) → draftId` (upsert por idea+perfil, estado `en_refinamiento`)
  - `updateDraft(db, draftId, {content, rawLlm})`; `setDraftStatus(db, draftId, status)`
  - `createChannelVersion(db, {draftId, profileChannelId, formatCode, textContent, mediaPath, status, scheduledAt}) → id`
  - `pendingFor(db, userId) → {ideas, drafts, programadas}` (para `/cola` en C2)
  - `connectedChannels(db, profileId) → [{profile_channel_id, channel_code, automatable_formats...}]` simplificado: `[{id, code}]` de `profile_channels` `conectado` + siempre `wa_status` si existe fila (o sin fila: se agrega automáticamente al vuelo con estado `desconectado`? NO — v1: solo canales con fila en profile_channels; wa_status debe cargarse como canal del perfil en el seed de onboarding. Para tests se insertan filas.)

- [ ] **Step 1: Test que falla**

`core-api/tests/editorial.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { makeTestApp } from './helpers.js'
import {
  createIdea, setIdeaStatus, linkIdeaProfiles, createDraft, updateDraft,
  setDraftStatus, createChannelVersion, pendingFor, connectedChannels,
} from '../src/services/editorial.js'

function setup() {
  const { db } = makeTestApp()
  const userId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  const profileId = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(userId, profileId)
  const evId = db.prepare("INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', 'x')").run(userId).lastInsertRowid
  return { db, userId, profileId, evId }
}

describe('editorial', () => {
  it('idea con evidencia vinculada y perfiles', () => {
    const { db, userId, profileId, evId } = setup()
    const ideaId = createIdea(db, { userId, title: 'Prueba del sensor', summary: 'ok', evidenceIds: [evId] })
    expect(db.prepare('SELECT status FROM ideas WHERE id=?').get(ideaId).status).toBe('capturada')
    expect(db.prepare('SELECT COUNT(*) n FROM idea_evidence WHERE idea_id=?').get(ideaId).n).toBe(1)
    linkIdeaProfiles(db, ideaId, [profileId])
    setIdeaStatus(db, ideaId, 'en_conversacion')
    expect(db.prepare('SELECT COUNT(*) n FROM idea_profiles WHERE idea_id=?').get(ideaId).n).toBe(1)
  })

  it('draft upsert por idea+perfil y versiones', () => {
    const { db, userId, profileId, evId } = setup()
    const ideaId = createIdea(db, { userId, title: 'T', summary: null, evidenceIds: [evId] })
    const d1 = createDraft(db, { ideaId, profileId, content: 'v1', rawLlm: '{}' })
    const d2 = createDraft(db, { ideaId, profileId, content: 'v2', rawLlm: '{}' })
    expect(d1).toBe(d2)
    expect(db.prepare('SELECT content FROM drafts WHERE id=?').get(d1).content).toBe('v2')
    updateDraft(db, d1, { content: 'v3', rawLlm: '{}' })
    setDraftStatus(db, d1, 'aprobado')
    const chId = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const pcId = db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(profileId, chId).lastInsertRowid
    const vId = createChannelVersion(db, {
      draftId: d1, profileChannelId: pcId, formatCode: 'texto',
      textContent: 'v3', mediaPath: null, status: 'programada', scheduledAt: '2026-07-18 09:00:00',
    })
    expect(db.prepare('SELECT status FROM channel_versions WHERE id=?').get(vId).status).toBe('programada')
  })

  it('pendingFor junta ideas sin desarrollar, drafts en refinamiento y programadas', () => {
    const { db, userId, profileId, evId } = setup()
    const ideaId = createIdea(db, { userId, title: 'Pend', summary: null, evidenceIds: [evId] })
    linkIdeaProfiles(db, ideaId, [profileId])
    const p = pendingFor(db, userId)
    expect(p.ideas.map((i) => i.title)).toContain('Pend')
    expect(p.drafts).toEqual([])
    expect(p.programadas).toEqual([])
  })

  it('connectedChannels solo conectados', () => {
    const { db, profileId } = setup()
    const li = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    const wa = db.prepare("SELECT id FROM channels WHERE code='wa_status'").get().id
    db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(profileId, li)
    db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'desconectado')").run(profileId, wa)
    const codes = connectedChannels(db, profileId).map((c) => c.code)
    expect(codes).toEqual(['linkedin'])
  })
})
```

- [ ] **Step 2: Verificar que falla** — módulo inexistente

- [ ] **Step 3: Implementar**

`core-api/src/services/editorial.js`:

```js
export function createIdea(db, { userId, title, summary = null, evidenceIds = [] }) {
  const id = db.prepare(
    'INSERT INTO ideas (created_by, title, summary) VALUES (?, ?, ?)'
  ).run(userId, title, summary).lastInsertRowid
  const link = db.prepare('INSERT INTO idea_evidence (idea_id, evidence_id) VALUES (?, ?)')
  for (const evId of evidenceIds) link.run(id, evId)
  return id
}

export function setIdeaStatus(db, ideaId, status) {
  db.prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, ideaId)
}

export function linkIdeaProfiles(db, ideaId, profileIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO idea_profiles (idea_id, profile_id) VALUES (?, ?)')
  for (const p of profileIds) ins.run(ideaId, p)
}

export function createDraft(db, { ideaId, profileId, content, rawLlm = null }) {
  db.prepare(`
    INSERT INTO drafts (idea_id, profile_id, content, raw_llm_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (idea_id, profile_id) DO UPDATE SET
      content = excluded.content, raw_llm_json = excluded.raw_llm_json, status = 'en_refinamiento'
  `).run(ideaId, profileId, content, rawLlm)
  return db.prepare('SELECT id FROM drafts WHERE idea_id = ? AND profile_id = ?').get(ideaId, profileId).id
}

export function updateDraft(db, draftId, { content, rawLlm = null }) {
  db.prepare('UPDATE drafts SET content = ?, raw_llm_json = ? WHERE id = ?').run(content, rawLlm, draftId)
}

export function setDraftStatus(db, draftId, status) {
  db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, draftId)
}

export function createChannelVersion(db, { draftId, profileChannelId, formatCode, textContent, mediaPath = null, status = 'pendiente', scheduledAt = null }) {
  return db.prepare(`
    INSERT INTO channel_versions (draft_id, profile_channel_id, format_code, text_content, media_path, status, scheduled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(draftId, profileChannelId, formatCode, textContent, mediaPath, status, scheduledAt).lastInsertRowid
}

export function pendingFor(db, userId) {
  const ideas = db.prepare(`
    SELECT i.id, i.title, i.status FROM ideas i
    WHERE i.created_by = ? AND i.status IN ('capturada', 'en_conversacion')
    ORDER BY i.id DESC
  `).all(userId)
  const drafts = db.prepare(`
    SELECT d.id, d.status, p.name AS profile, i.title FROM drafts d
    JOIN brand_profiles p ON p.id = d.profile_id
    JOIN ideas i ON i.id = d.idea_id
    WHERE i.created_by = ? AND d.status = 'en_refinamiento'
    ORDER BY d.id DESC
  `).all(userId)
  const programadas = db.prepare(`
    SELECT v.id, v.format_code, v.scheduled_at, c.code AS channel FROM channel_versions v
    JOIN drafts d ON d.id = v.draft_id
    JOIN ideas i ON i.id = d.idea_id
    JOIN profile_channels pc ON pc.id = v.profile_channel_id
    JOIN channels c ON c.id = pc.channel_id
    WHERE i.created_by = ? AND v.status = 'programada'
    ORDER BY v.scheduled_at
  `).all(userId)
  return { ideas, drafts, programadas }
}

export function connectedChannels(db, profileId) {
  return db.prepare(`
    SELECT pc.id, c.code FROM profile_channels pc
    JOIN channels c ON c.id = pc.channel_id
    WHERE pc.profile_id = ? AND pc.status = 'conectado'
    ORDER BY c.id
  `).all(profileId)
}
```

- [ ] **Step 4: Suite completa** — PASS
- [ ] **Step 5: Commit** — `git add core-api/src/services/editorial.js core-api/tests/editorial.test.js && git commit -m "feat(core-api): repositorio editorial de ideas, bocetos y versiones"`

---

### Task 3: Redactor (LLM) con prompts versionados

**Files:**
- Create: `core-api/prompts/proponer-idea.md`, `core-api/prompts/redactar-boceto.md`, `core-api/prompts/adaptar-version.md`
- Create: `core-api/src/services/redactor.js`
- Test: `core-api/tests/redactor.test.js`

**Interfaces:**
- Produces (todas `{fetchImpl?}`, devuelven `{..., raw}` y lanzan `AiError` en falla — el llamador decide el fallback):
  - `proponerIdea(evidencias, {fetchImpl}) → {title, summary, raw}` (JSON del LLM `{titulo, resumen}`)
  - `redactarBoceto(profile, idea, evidencias, {fetchImpl}) → {content, raw}` — inyecta name + identity_json
  - `refinarBoceto(profile, contenidoActual, feedback, {fetchImpl}) → {content, raw}`
  - `adaptarVersion(profile, contenido, channelCode, formatCode, {fetchImpl}) → {text, hashtags, raw}` (JSON `{texto, hashtags}`)

- [ ] **Step 1: Prompts**

`core-api/prompts/proponer-idea.md`:

```markdown
Sos el editor de un sistema de marca personal. Recibís evidencia capturada
(transcripciones, descripciones de fotos, textos) de un avance personal o laboral.
Proponé UNA idea de contenido.

Devolvé SOLO JSON: {"titulo": "<máx 80 caracteres, concreto>", "resumen": "<1-2 frases de qué contaría el post>"}
En español. No inventes hechos que no estén en la evidencia.
```

`core-api/prompts/redactar-boceto.md`:

```markdown
Sos el ghostwriter de una marca. Escribí UN post en español listo para publicar.

PERFIL DE MARCA (respetalo estrictamente: tono, público, temáticas, palabras
frecuentes, nivel técnico; jamás uses lo listado en "nunca_comunicar"):
__PERFIL__

IDEA A DESARROLLAR:
__IDEA__

EVIDENCIA DISPONIBLE (hechos reales, no inventes nada fuera de esto):
__EVIDENCIA__

Reglas: primera persona si el perfil es personal, voz institucional si es empresa.
Sin hashtags (van aparte). Largo: 500-1200 caracteres. Devolvé SOLO el texto del post.
```

`core-api/prompts/adaptar-version.md`:

```markdown
Adaptá este post al canal y formato indicados. Mantené la voz del perfil.

PERFIL: __PERFIL__
POST APROBADO: __POST__
CANAL: __CANAL__ · FORMATO: __FORMATO__

Reglas por canal: linkedin → hasta 2900 caracteres, tono profesional, 3-5 hashtags;
instagram → hasta 2000 caracteres, más visual y directo, 5-10 hashtags;
wa_status → 1-2 frases potentes (va sobre una imagen).

Devolvé SOLO JSON: {"texto": "<el post adaptado>", "hashtags": "<#uno #dos ...>"}
```

- [ ] **Step 2: Test que falla**

`core-api/tests/redactor.test.js`:

```js
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
    const res = await refinarBoceto(profile, 'texto viejo', 'menos épico, más técnico', { fetchImpl })
    expect(res.content).toBe('Versión más técnica…')
    expect(JSON.stringify(llm.lastBody.messages)).toContain('menos épico')
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
```

- [ ] **Step 3: Verificar que falla** — módulo inexistente

- [ ] **Step 4: Implementar**

`core-api/src/services/redactor.js`:

```js
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
    .replace('__PERFIL__', perfilTexto(profile))
    .replace('__IDEA__', `${idea.title}${idea.summary ? ` — ${idea.summary}` : ''}`)
    .replace('__EVIDENCIA__', evidenciaTexto(evidencias))
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
    .replace('__PERFIL__', perfilTexto(profile))
    .replace('__POST__', contenido)
    .replace('__CANAL__', channelCode)
    .replace('__FORMATO__', formatCode)
  const { content, raw } = await chat('redactar', [
    { role: 'system', content: sys },
    { role: 'user', content: 'Adaptá el post.' },
  ], { json: true, fetchImpl })
  const parsed = parseJson(content, 'adaptar versión')
  return { text: parsed.texto || contenido, hashtags: parsed.hashtags || '', raw }
}
```

- [ ] **Step 5: Suite completa** — PASS
- [ ] **Step 6: Commit** — `git add core-api/prompts/ core-api/src/services/redactor.js core-api/tests/redactor.test.js && git commit -m "feat(core-api): redactor LLM con prompts versionados por perfil"`

---

### Task 4: Imagen procesada con plantilla de marca (sharp)

**Files:**
- Modify: `core-api/package.json` (agregar `"sharp": "^0.33.0"` a dependencies, `npm install`)
- Create: `core-api/src/services/imagen.js`
- Test: `core-api/tests/imagen.test.js`

**Interfaces:**
- Produces: `renderChannelImage(srcPath, outPath, {width, height, label}) → outPath` — cover al tamaño + barra inferior semitransparente con el nombre de la marca. `FORMAT_DIMENSIONS = { 'linkedin:imagen': {width:1200,height:627}, 'instagram:feed': {width:1080,height:1350}, 'instagram:historia': {width:1080,height:1920}, 'wa_status:historia': {width:1080,height:1920} }`.

- [ ] **Step 1: Instalar sharp** — `cd core-api && npm install sharp@^0.33.0`

- [ ] **Step 2: Test que falla**

`core-api/tests/imagen.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { renderChannelImage, FORMAT_DIMENSIONS } from '../src/services/imagen.js'

describe('imagen de marca', () => {
  it('renderiza cover al tamaño del formato con barra de marca', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pbos-img-'))
    const src = path.join(dir, 'src.png')
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 100, b: 200 } } })
      .png().toFile(src)
    const out = path.join(dir, 'out.jpg')
    const dims = FORMAT_DIMENSIONS['instagram:feed']
    await renderChannelImage(src, out, { ...dims, label: 'SkyTrace' })
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(1080)
    expect(meta.height).toBe(1350)
    expect(meta.format).toBe('jpeg')
  })

  it('el catálogo de dimensiones cubre los formatos v1', () => {
    expect(FORMAT_DIMENSIONS['linkedin:imagen']).toEqual({ width: 1200, height: 627 })
    expect(FORMAT_DIMENSIONS['wa_status:historia']).toEqual({ width: 1080, height: 1920 })
  })
})
```

- [ ] **Step 3: Verificar que falla** — módulo inexistente

- [ ] **Step 4: Implementar**

`core-api/src/services/imagen.js`:

```js
import sharp from 'sharp'

export const FORMAT_DIMENSIONS = {
  'linkedin:imagen': { width: 1200, height: 627 },
  'instagram:feed': { width: 1080, height: 1350 },
  'instagram:historia': { width: 1080, height: 1920 },
  'wa_status:historia': { width: 1080, height: 1920 },
}

export async function renderChannelImage(srcPath, outPath, { width, height, label }) {
  const barH = Math.round(height * 0.06)
  const fontSize = Math.round(barH * 0.5)
  const svg = Buffer.from(`
    <svg width="${width}" height="${barH}">
      <rect width="100%" height="100%" fill="black" fill-opacity="0.55"/>
      <text x="${Math.round(width * 0.02)}" y="${Math.round(barH * 0.68)}"
        font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}"
        fill="white">${escapeXml(label)}</text>
    </svg>
  `)
  await sharp(srcPath)
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .composite([{ input: svg, top: height - barH, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath)
  return outPath
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
}
```

- [ ] **Step 5: Suite completa** — PASS
- [ ] **Step 6: Commit** — `git add core-api/package.json core-api/package-lock.json core-api/src/services/imagen.js core-api/tests/imagen.test.js && git commit -m "feat(core-api): imagen procesada con plantilla de marca (sharp)"`

---

### Task 5: Máquina de estados del agente

**Files:**
- Create: `core-api/src/agent/next-turn.js`
- Test: `core-api/tests/next-turn.test.js`

**Interfaces:**
- Consumes: sessions (T1), editorial (T2), redactor (T3), imagen (T4), `can` (permisos), MEDIA_DIR.
- Produces: `nextTurn(db, user, chatId, input, {fetchImpl?}) → {texto, botones, estado}` — contrato y botones EXACTOS de Global Constraints. Nunca lanza (fallback amable, sesión intacta si el LLM falla).
- Flujo implementado:
  - `evidencia` en cualquier estado → guarda ideaId propuesto: llama `proponerIdea` con el detalle → estado `proponiendo_idea`, botones idea_*.
  - `idea_desarrollar` → lista perfiles del usuario (`user_profile_access` join) → estado `eligiendo_perfiles`, botones `perfil_<id>`/`perfil_ambas`; si el usuario tiene UN solo perfil, saltea la elección y va directo a redactar.
  - `idea_guardar` → idea queda `capturada`, sesión `inicio`, texto confirmación.
  - `idea_descartar` → idea `descartada`, sesión `inicio`.
  - `perfil_<id>` / `perfil_ambas` → por CADA perfil elegido: `redactarBoceto` → draft; presenta el primero → estado `refinando_boceto` (data: cola de drafts pendientes), botones boceto_*.
  - `texto` en `refinando_boceto` → `refinarBoceto` con ese feedback → nuevo contenido, mismos botones.
  - `boceto_otra` → re-redacta (mismo prompt) → reemplaza contenido.
  - `boceto_descartar` → draft `descartado`; pasa al siguiente draft de la cola o `inicio`.
  - `boceto_aprobar` → draft `aprobado`; si quedan drafts en cola presenta el siguiente; si no → estado `programando`, botones prog_*.
  - `prog_*` → para cada draft aprobado de la idea: `connectedChannels` del perfil → por canal: formato propuesto (media→formato con imagen; texto→texto), `adaptarVersion`, imagen procesada si corresponde (`renderChannelImage` a `MEDIA_DIR/versions/…`), `createChannelVersion` con estado/scheduled según botón (`prog_ahora` → programada + now; `prog_maniana` → programada + mañana 09:00; `prog_cola` → aprobada). Idea → `lista`. Sesión `inicio`. Texto resumen de qué quedó dónde.
  - `comando` `/cola` → `pendingFor` formateado. `/idea <texto>` → crea idea manual y arranca en `proponiendo_idea`... simplificación: `/idea` sin LLM: usa el texto como título, va directo a botones idea_*.
  - cualquier otra cosa en `inicio` → texto guía breve.

- [ ] **Step 1: Test que falla** — `core-api/tests/next-turn.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeTestApp } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'

const llmRouter = (respuestas) => {
  let i = 0
  return async (_u, opts) => {
    const body = JSON.parse(opts.body)
    const content = typeof respuestas === 'function' ? respuestas(body) : respuestas[i++]
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  }
}

function setup({ profiles = 1 } = {}) {
  const { db } = makeTestApp()
  process.env.GROQ_API_KEY = 'gsk-test'
  const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
  const ids = []
  for (let i = 0; i < profiles; i++) {
    const pid = db.prepare('INSERT INTO brand_profiles (name, slug) VALUES (?, ?)')
      .run(i === 0 ? 'Juan Pablo' : 'SkyTrace', i === 0 ? 'jp' : 'sky').lastInsertRowid
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(user.id, pid)
    const li = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(pid, li)
    ids.push(pid)
  }
  const evId = db.prepare(
    "INSERT INTO evidence (user_id, type, text_content, transcription) VALUES (?, 'audio', NULL, 'probamos el dron')"
  ).run(user.id).lastInsertRowid
  const evidencia = { id: evId, folio: 'E-0001', processed: true, detalle: { transcription: 'probamos el dron', vision_description: null, entities: [] } }
  return { db, user, ids, evidencia }
}

describe('next-turn', () => {
  it('evidencia → propone idea con botones', async () => {
    const { db, user, evidencia } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, {
      fetchImpl: llmRouter(['{"titulo": "Vuelo exitoso", "resumen": "contarlo"}']),
    })
    expect(res.estado).toBe('proponiendo_idea')
    expect(res.texto).toContain('Vuelo exitoso')
    expect(res.botones.map((b) => b.id)).toEqual(['idea_desarrollar', 'idea_guardar', 'idea_descartar'])
  })

  it('con un solo perfil saltea la elección y redacta directo', async () => {
    const { db, user, evidencia } = setup()
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']) })
    const res = await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, {
      fetchImpl: llmRouter(['Hoy probamos el dron y salió perfecto.']),
    })
    expect(res.estado).toBe('refinando_boceto')
    expect(res.texto).toContain('Hoy probamos el dron')
    expect(res.botones.map((b) => b.id)).toEqual(['boceto_aprobar', 'boceto_otra', 'boceto_descartar'])
  })

  it('con dos perfiles ofrece elegir', async () => {
    const { db, user, evidencia } = setup({ profiles: 2 })
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']) })
    const res = await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llmRouter([]) })
    expect(res.estado).toBe('eligiendo_perfiles')
    const ids = res.botones.map((b) => b.id)
    expect(ids).toContain('perfil_ambas')
    expect(ids.filter((i) => i.startsWith('perfil_')).length).toBe(3)
  })

  it('feedback de texto refina el boceto', async () => {
    const { db, user, evidencia } = setup()
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']) })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llmRouter(['borrador 1']) })
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'más técnico' }, { fetchImpl: llmRouter(['borrador 2 técnico']) })
    expect(res.texto).toContain('borrador 2 técnico')
    expect(res.estado).toBe('refinando_boceto')
  })

  it('aprobar → programando → prog_cola crea versiones aprobadas', async () => {
    const { db, user, evidencia } = setup()
    const fetchImpl = llmRouter((body) => {
      const s = JSON.stringify(body.messages)
      if (s.includes('proponer') || s.includes('evidencia capturada') || s.includes('Evidencia')) {
        if (body.response_format) {
          if (s.includes('Adaptá') || s.includes('adaptado')) return '{"texto": "adaptado", "hashtags": "#a"}'
          return '{"titulo": "T", "resumen": null}'
        }
      }
      if (body.response_format) return '{"texto": "adaptado", "hashtags": "#a"}'
      return 'borrador'
    })
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl })
    const prog = await nextTurn(db, user, '111', { clase: 'boton', boton: 'boceto_aprobar' }, { fetchImpl })
    expect(prog.estado).toBe('programando')
    const fin = await nextTurn(db, user, '111', { clase: 'boton', boton: 'prog_cola' }, { fetchImpl })
    expect(fin.estado).toBe('inicio')
    const versiones = db.prepare('SELECT status, format_code FROM channel_versions').all()
    expect(versiones.length).toBeGreaterThan(0)
    expect(versiones.every((v) => v.status === 'aprobada')).toBe(true)
  })

  it('LLM caído: fallback amable sin romper la sesión', async () => {
    const { db, user, evidencia } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, {
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }),
    })
    expect(res.texto).toMatch(/guardada/i)
    expect(res.estado).toBe('inicio')
  })

  it('/cola responde pendientes', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'comando', comando: '/cola' }, {})
    expect(res.texto).toBeTruthy()
    expect(res.estado).toBe('inicio')
  })
})
```

- [ ] **Step 2: Verificar que falla** — módulo inexistente

- [ ] **Step 3: Implementar** — `core-api/src/agent/next-turn.js` implementando exactamente el flujo de Interfaces. Estructura sugerida (el implementador la completa siguiendo los tests como contrato):

```js
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { getSession, setSession, clearSession } from '../services/sessions.js'
import {
  createIdea, setIdeaStatus, linkIdeaProfiles, createDraft, updateDraft,
  setDraftStatus, createChannelVersion, pendingFor, connectedChannels,
} from '../services/editorial.js'
import { proponerIdea, redactarBoceto, refinarBoceto, adaptarVersion } from '../services/redactor.js'
import { renderChannelImage, FORMAT_DIMENSIONS } from '../services/imagen.js'

const BOTONES_IDEA = [
  { id: 'idea_desarrollar', label: '✍️ Desarrollar' },
  { id: 'idea_guardar', label: '📥 Solo guardar' },
  { id: 'idea_descartar', label: '🗑 Descartar' },
]
const BOTONES_BOCETO = [
  { id: 'boceto_aprobar', label: '✅ Aprobar' },
  { id: 'boceto_otra', label: '🔄 Otra versión' },
  { id: 'boceto_descartar', label: '🗑 Descartar' },
]
const BOTONES_PROG = [
  { id: 'prog_ahora', label: '🚀 Ahora' },
  { id: 'prog_maniana', label: '🌅 Mañana 9hs' },
  { id: 'prog_cola', label: '⏳ A la cola' },
]

export async function nextTurn(db, user, chatId, input, { fetchImpl } = {}) {
  try {
    return await dispatch(db, user, chatId, input, { fetchImpl })
  } catch (err) {
    // regla de oro: jamás romper la conversación
    return {
      texto: '⚠️ Algo falló de mi lado. Tu material está guardado — probá de nuevo en un rato.',
      botones: [],
      estado: (getSession(db, user.id, chatId) || { state: 'inicio' }).state,
    }
  }
}

// dispatch: switch por input.clase y estado de sesión, implementando el flujo
// completo descrito en Interfaces (los tests de next-turn.test.js son el contrato).
// Helpers internos sugeridos:
//  - perfilesDe(db, userId) → [{id, name}]
//  - evidenciasDeIdea(db, ideaId) → filas de evidence con transcription/vision/text
//  - presentarBoceto(profile, content) → texto con encabezado del perfil
//  - crearVersiones(db, user, idea, boton, {fetchImpl}) → resumen por canal
//    (usa connectedChannels + adaptarVersion + renderChannelImage con
//     FORMAT_DIMENSIONS['<code>:<formato>'] cuando la idea tiene evidencia foto;
//     media original: primera evidence tipo foto de la idea; salida en
//     MEDIA_DIR/versions/v<id>.jpg)
//  - fallo de LLM en proponerIdea con clase evidencia → responder
//    'Evidencia E-xxxx guardada' + estado inicio (la captura nunca se pierde)
```

El implementador escribe `dispatch` completo. Requisitos duros verificados por los tests: ids de botones exactos, salto de elección con un solo perfil, cola de drafts para multi-perfil, refinamiento por texto en `refinando_boceto`, `prog_cola` → versiones `aprobada`, `prog_maniana` → `programada` con `scheduled_at` mañana 09:00, `prog_ahora` → `programada` con `scheduled_at` ahora, fallback ante LLM caído con evidencia (texto contiene 'guardada'), `/cola` vía `pendingFor`, `/idea <texto>` crea idea con ese título y botones idea_*.

- [ ] **Step 4: Suite completa** — PASS
- [ ] **Step 5: Commit** — `git add core-api/src/agent/ core-api/tests/next-turn.test.js && git commit -m "feat(core-api): maquina de estados conversacional del agente"`

---

### Task 6: Ruta del agente + registro en app

**Files:**
- Create: `core-api/src/routes/agent.js`
- Modify: `core-api/src/app.js`
- Test: `core-api/tests/agent-route.test.js`

**Interfaces:**
- Produces: `POST /api/agent/next-turn` (auth por header como todo /api): body `{input}` → `{texto, botones, estado}`; 400 si falta `input.clase`.

- [ ] **Step 1: Test que falla**

`core-api/tests/agent-route.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT } from './helpers.js'

describe('POST /api/agent/next-turn', () => {
  it('400 sin input.clase', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/agent/next-turn')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT).send({})
    expect(res.status).toBe(400)
  })

  it('comando /cola responde siempre con texto', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/agent/next-turn')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ input: { clase: 'comando', comando: '/cola' } })
    expect(res.status).toBe(200)
    expect(res.body.texto).toBeTruthy()
    expect(res.body.estado).toBe('inicio')
    expect(Array.isArray(res.body.botones)).toBe(true)
  })

  it('403 para desconocidos (lo maneja el middleware)', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/agent/next-turn')
      .set('X-Telegram-Chat-Id', '999')
      .send({ input: { clase: 'comando', comando: '/cola' } })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Verificar que falla** — 404

- [ ] **Step 3: Implementar**

`core-api/src/routes/agent.js`:

```js
import { Router } from 'express'
import { nextTurn } from '../agent/next-turn.js'

export function agentRouter(db) {
  const r = Router()
  r.post('/next-turn', async (req, res, next) => {
    try {
      const input = req.body?.input
      if (!input || !input.clase) return res.status(400).json({ error: 'falta input.clase' })
      const out = await nextTurn(db, req.user, req.user.telegram_chat_id, input, {
        fetchImpl: req.app.locals.aiFetch,
      })
      res.json(out)
    } catch (err) { next(err) }
  })
  return r
}
```

En `core-api/src/app.js`: `import { agentRouter } from './routes/agent.js'` y `api.use('/agent', agentRouter(db))` junto a los otros montajes.

- [ ] **Step 4: Suite completa** — PASS
- [ ] **Step 5: Commit** — `git add core-api/src/routes/agent.js core-api/src/app.js core-api/tests/agent-route.test.js && git commit -m "feat(core-api): endpoint next-turn del agente conversacional"`

---

## Self-Review del plan (ejecutada)

1. **Cobertura vs spec:** §5 flujo principal completo (idea→perfiles→boceto→refinamiento→aprobación→programación), captura muda (idea_guardar), /cola, /idea, fallback y nunca-silencio; §4.8-4.10 (ideas/drafts/versions con estados exactos); §6 formato propuesto por código; imagen procesada con plantilla (§3 procesar-sin-IA). NO cubre (asignado): integración Telegram de botones y workflow v2 → C2; iniciativa del bot por cadencia → v1.5 (spec lo permite); etiquetado social propuesto en bocetos → C2/D.
2. **Placeholders:** Task 5 Step 3 delega el cuerpo de `dispatch` al implementador A PROPÓSITO con contrato de tests exhaustivo (7 tests) + helpers sugeridos — decisión consciente para no fijar 300 líneas que los tests ya especifican mejor. El resto: código completo.
3. **Consistencia:** botones/estados idénticos entre Global Constraints, T5 y tests; `evidencia` del input = shape exacto de la respuesta del POST /api/evidence de B2-T1; `FORMAT_DIMENSIONS` keys `<channel>:<format>` = codes del seed Plan A.
