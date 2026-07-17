# Plan C2 — Conversación por Telegram (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar el cerebro (C1) con Telegram: botones inline (aprobar/refinar/programar) tocables desde el celular, texto libre como evidencia o feedback según el estado, comandos `/cola` y `/idea`, y el fallback del puente para que nunca haya silencio.

**Architecture:** El workflow n8n pasa a tener DOS caminos: media (foto/audio/video) → `POST /api/evidence` → `next-turn {clase:'evidencia'}`; todo lo demás (texto/botón/comando) → `next-turn` directo. La respuesta `{texto, botones}` se renderiza como inline keyboard. El puente gana soporte de `callback_query` (con answer inmediato para cortar el spinner) y el fallback `sendMessage` diferido de B2.

**Plan series:** A ✅ B1 ✅ B2 ✅ C1 ✅ · **C2 (este)** · D · E.

## Global Constraints

- `clase 'texto'` en estado `inicio` = captura: `next-turn` crea la evidencia internamente (INSERT + `processEvidence`) y sigue el flujo de evidencia. En `refinando_boceto` = feedback (ya implementado C1). En otros estados = guía.
- callback_query: el puente responde `answerCallbackQuery` best-effort ANTES de reenviar, y manda payload `{chatId, tipo:'boton', boton:<data>}`.
- Fallback del puente (deuda B2): si `forwardUpdate` falla para un update mapeado, best-effort `sendMessage` "⚠️ No pude procesar ese mensaje. Probá de nuevo en un rato." — jamás lanza.
- Mensajes SIN `parse_mode` (texto plano — el título puede tener `*`/`_`; hallazgo C1).
- Inline keyboard: filas de máximo 3 botones: `reply_markup: { inline_keyboard: chunk(botones,3).map(fila => fila.map(b => ({text: b.label, callback_data: b.id}))) }`.
- El nodo 02 (respuesta) mantiene: 403 → silencio; error → fallback amable; truncado 4000.
- Workflow SIEMPRE regenerado por build; tests de estructura actualizados. Tests sin red. Español. TDD. Branch `claude/nuevo-proyecto-dxakbn`.

## File Structure

```
core-api/src/agent/next-turn.js        # (modif) clase texto en inicio crea evidencia
puente-telegram/src/mapper.js          # (modif) callback_query
puente-telegram/src/bridge.js          # (modif) answerCallbackQuery + fallback sendMessage
n8n/src/01-preparar-turno.js           # (nuevo, reemplaza 01-preparar-evidencia.js)
n8n/src/02-armar-respuesta.js          # (modif) inline keyboard + camino next-turn
n8n/build-workflow.mjs                 # (modif) nueva topología
core-api/tests/next-turn-texto.test.js
core-api/tests/bridge-callback.test.js
core-api/tests/n8n-nodes.test.js       # (modif)
core-api/tests/n8n-workflow.test.js    # (modif)
README.md                              # (modif) guía de prueba conversacional
```

---

### Task 1: `clase 'texto'` en `inicio` captura evidencia

**Files:**
- Modify: `core-api/src/agent/next-turn.js`
- Test: `core-api/tests/next-turn-texto.test.js`

**Interfaces:**
- Produces: en estado `inicio` (o sin sesión), `input {clase:'texto', texto}` → crea fila en `evidence` (type 'texto', user_id, text_content), corre `processEvidence` (tolerante), y continúa EXACTAMENTE como `clase:'evidencia'` (propone idea con botones idea_*). El texto de respuesta incluye el folio.

- [ ] **Step 1: Test que falla**

`core-api/tests/next-turn-texto.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestApp } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'

const llm = (contents) => {
  let i = 0
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: contents[i++] } }] }) })
}

function setup() {
  const { db } = makeTestApp()
  process.env.GROQ_API_KEY = 'gsk-test'
  const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
  const pid = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(user.id, pid)
  return { db, user }
}

describe('texto en inicio = captura', () => {
  it('crea evidencia y propone idea', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'hoy probamos el sensor nuevo' }, {
      fetchImpl: llm([
        JSON.stringify({ entidades: [] }),               // pipeline: entidades
        '{"titulo": "Sensor nuevo", "resumen": "contarlo"}', // proponer idea
      ]),
    })
    expect(res.estado).toBe('proponiendo_idea')
    expect(res.texto).toMatch(/E-\d{4}/)
    expect(res.botones.map((b) => b.id)).toContain('idea_desarrollar')
    const ev = db.prepare("SELECT * FROM evidence WHERE type='texto'").get()
    expect(ev.text_content).toBe('hoy probamos el sensor nuevo')
    expect(ev.user_id).toBe(user.id)
  })

  it('texto en refinando_boceto sigue siendo feedback (no crea evidencia)', async () => {
    const { db, user } = setup()
    await nextTurn(db, user, '111', { clase: 'texto', texto: 'evidencia base' }, {
      fetchImpl: llm([JSON.stringify({ entidades: [] }), '{"titulo": "T", "resumen": null}']),
    })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llm(['borrador 1']) })
    const antes = db.prepare('SELECT COUNT(*) n FROM evidence').get().n
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'más corto' }, { fetchImpl: llm(['borrador corto']) })
    expect(res.texto).toContain('borrador corto')
    expect(db.prepare('SELECT COUNT(*) n FROM evidence').get().n).toBe(antes)
  })

  it('IA caída: la evidencia queda igual (regla de oro)', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'captura resiliente' }, {
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }),
    })
    expect(res.texto).toMatch(/guardada/i)
    expect(db.prepare("SELECT COUNT(*) n FROM evidence WHERE text_content='captura resiliente'").get().n).toBe(1)
  })
})
```

- [ ] **Step 2: RED** — los tests fallan (texto en inicio hoy devuelve guía)
- [ ] **Step 3: Implementar** — en `next-turn.js`, en el manejo de `clase 'texto'` cuando el estado es `inicio`/sin sesión: insertar evidencia (`INSERT INTO evidence (user_id, type, text_content) VALUES (?, 'texto', ?)`), llamar `processEvidence(db, id, {fetchImpl})` (import desde services), armar el objeto `evidencia` con `{id, folio: E-%04d, processed, detalle}` (leyendo la fila + entidades como hace la ruta) y delegar al handler de evidencia existente. Reutilizar el helper `entitiesFor` NO está exportado desde la ruta — duplicar la query corta acá o extraerla a `services/editorial.js`… decisión: extraer `entitiesFor(db, evidenceId)` a `core-api/src/services/entities-store.js` (export nuevo) y usarla desde la ruta de evidencia Y desde next-turn (reemplazar la duplicación existente).
- [ ] **Step 4: Suite completa** — PASS (los tests de evidencia existentes siguen verdes)
- [ ] **Step 5: Commit** — `git add core-api/src/agent/next-turn.js core-api/src/services/entities-store.js core-api/src/routes/evidence.js core-api/tests/next-turn-texto.test.js && git commit -m "feat(core-api): texto en inicio captura evidencia y propone idea"`

---

### Task 2: Puente — callback_query, answer y fallback

**Files:**
- Modify: `puente-telegram/src/mapper.js`, `puente-telegram/src/bridge.js`
- Test: `core-api/tests/bridge-callback.test.js`

**Interfaces:**
- `mapUpdate`: update con `callback_query` → `{chatId, tipo:'boton', boton: <data>, callbackQueryId: <id>}` (chatId de `callback_query.message.chat.id`).
- `forwardUpdate`: si el mapeado tiene `callbackQueryId` → best-effort POST `${api}/answerCallbackQuery` con `{callback_query_id}` ANTES del webhook (falla ignorada); el payload al webhook NO incluye `callbackQueryId`.
- `runOnce`: si `forwardUpdate` lanza y el update mapeaba a un chat conocido → best-effort `sendMessage` con el texto exacto '⚠️ No pude procesar ese mensaje. Probá de nuevo en un rato.' (falla ignorada, se loguea igual el error original).

- [ ] **Step 1: Test que falla**

`core-api/tests/bridge-callback.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mapUpdate } from '../../puente-telegram/src/mapper.js'
import { forwardUpdate, runOnce } from '../../puente-telegram/src/bridge.js'

const deps = (fetchImpl, log = { error: () => {} }) =>
  ({ token: 'TOK', webhook: 'http://n8n:5678/webhook/telegram', fetchImpl, log })

describe('callback_query', () => {
  it('mapea botón', () => {
    const u = { update_id: 1, callback_query: { id: 'cbq9', data: 'boceto_aprobar', message: { chat: { id: 42 } } } }
    expect(mapUpdate(u)).toEqual({ chatId: '42', tipo: 'boton', boton: 'boceto_aprobar', callbackQueryId: 'cbq9' })
  })

  it('forwardUpdate responde el callback y reenvía sin callbackQueryId', async () => {
    const calls = []
    const f = async (u, opts) => { calls.push({ u, body: opts?.body && JSON.parse(opts.body) }); return { ok: true } }
    const u = { update_id: 2, callback_query: { id: 'cbq1', data: 'prog_cola', message: { chat: { id: 7 } } } }
    const res = await forwardUpdate(u, deps(f))
    expect(res.forwarded).toBe(true)
    expect(calls[0].u).toContain('/answerCallbackQuery')
    expect(calls[0].body).toEqual({ callback_query_id: 'cbq1' })
    expect(calls[1].u).toBe('http://n8n:5678/webhook/telegram')
    expect(calls[1].body).toEqual({ chatId: '7', tipo: 'boton', boton: 'prog_cola' })
  })

  it('answerCallbackQuery fallido no impide el reenvío', async () => {
    const f = async (u, opts) => {
      if (u.includes('answerCallbackQuery')) throw new Error('timeout')
      return { ok: true }
    }
    const u = { update_id: 3, callback_query: { id: 'x', data: 'd', message: { chat: { id: 7 } } } }
    expect((await forwardUpdate(u, deps(f))).forwarded).toBe(true)
  })
})

describe('fallback del puente', () => {
  it('webhook caído → sendMessage de disculpa best-effort', async () => {
    const sent = []
    const f = async (u, opts) => {
      if (u.includes('getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 5, message: { chat: { id: 9 }, text: 'hola' } },
      ] }) }
      if (u.includes('sendMessage')) { sent.push(JSON.parse(opts.body)); return { ok: true } }
      return { ok: false, status: 502 } // webhook
    }
    const next = await runOnce(0, deps(f))
    expect(next).toBe(6)
    expect(sent).toHaveLength(1)
    expect(sent[0].chat_id).toBe('9')
    expect(sent[0].text).toMatch(/No pude procesar/)
  })

  it('si también falla el sendMessage, no lanza', async () => {
    const f = async (u) => {
      if (u.includes('getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 6, message: { chat: { id: 9 }, text: 'hola' } },
      ] }) }
      throw new Error('todo caído')
    }
    await expect(runOnce(0, deps(f))).resolves.toBe(7)
  })
})
```

- [ ] **Step 2: RED**
- [ ] **Step 3: Implementar** — mapper: rama `update.callback_query` al inicio. bridge: en `forwardUpdate`, si `mapped.callbackQueryId`: `try { await fetchImpl(`${api(token)}/answerCallbackQuery`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({callback_query_id: mapped.callbackQueryId})}) } catch {}` y `delete payload.callbackQueryId`. En `runOnce` catch: además del log, `try { await fetchImpl(`${api(deps.token)}/sendMessage`, {...{chat_id: mapUpdate(u)?.chatId, text: '⚠️ No pude procesar ese mensaje. Probá de nuevo en un rato.'}}) } catch {}` (solo si mapUpdate(u) no es null).
- [ ] **Step 4: Suite completa** — PASS (tests B2 del puente siguen verdes)
- [ ] **Step 5: Commit** — `git add puente-telegram/src/ core-api/tests/bridge-callback.test.js && git commit -m "feat(puente): botones inline (callback_query) y fallback de disculpa"`

---

### Task 3: Nodos n8n v2 (turno + respuesta con teclado)

**Files:**
- Create: `n8n/src/01-preparar-turno.js` (delete: `n8n/src/01-preparar-evidencia.js`)
- Modify: `n8n/src/02-armar-respuesta.js`
- Test: modify `core-api/tests/n8n-nodes.test.js` (reescribir para los nuevos contratos)

**Interfaces:**
- `01-preparar-turno.js`: entrada `$json.body` del puente. Salida:
  - media (`foto|audio|video` con content_base64) → `{chatId, camino:'evidencia', evidencePost:{...igual que B2}}`
  - texto → `{chatId, camino:'turno', input:{clase:'texto', texto}}`
  - boton → `{chatId, camino:'turno', input:{clase:'boton', boton}}`
  - comando → `{chatId, camino:'turno', input:{clase:'comando', comando}}` (los comandos van al agente — `/start` lo responde el agente vía guía... NO: `/start` responde el propio nodo como en B2 con `camino:'ayuda'` y `{texto}` directo — mantener la AYUDA local con la lista actualizada de comandos: /start, /cola, /idea)
- Nodo intermedio `03-armar-turno-evidencia.js` (Create): tras Persistir evidencia (fullResponse), arma `{chatId, input:{clase:'evidencia', evidencia: body}}` o `{chatId, respuestaDirecta:{...}}` si status≠201 (reusa la lógica de error de B2: 403 silencio / fallback amable).
- `02-armar-respuesta.js` v2: entrada = respuesta full del HTTP next-turn `{statusCode, body:{texto, botones, estado}}` (o `respuestaDirecta` pass-through del nodo 03, o `{texto}` de ayuda). Salida `{responder, chatId, texto, reply_markup}` con `reply_markup = {inline_keyboard: filas de máx 3}` solo si hay botones; truncado 4000; 403 → silencio; error → fallback.

- [ ] **Step 1: RED** — reescribir `core-api/tests/n8n-nodes.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { runCodeNode } from './n8n-harness.js'

describe('nodo 01: preparar turno', () => {
  it('foto → camino evidencia', () => {
    const [out] = runCodeNode('01-preparar-turno.js', {
      json: { body: { chatId: '9', tipo: 'foto', filename: 'f.jpg', content_base64: 'QQ==', caption: 'obra' } },
    })
    expect(out.json.camino).toBe('evidencia')
    expect(out.json.evidencePost.type).toBe('foto')
  })

  it('texto → turno clase texto', () => {
    const [out] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'texto', texto: 'hola' } } })
    expect(out.json).toEqual({ chatId: '9', camino: 'turno', input: { clase: 'texto', texto: 'hola' } })
  })

  it('boton → turno clase boton', () => {
    const [out] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'boton', boton: 'idea_guardar' } } })
    expect(out.json.input).toEqual({ clase: 'boton', boton: 'idea_guardar' })
  })

  it('/start → ayuda local; otros comandos → turno', () => {
    const [ayuda] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'comando', comando: '/start' } } })
    expect(ayuda.json.camino).toBe('ayuda')
    expect(ayuda.json.texto).toMatch(/\/cola/)
    const [cola] = runCodeNode('01-preparar-turno.js', { json: { body: { chatId: '9', tipo: 'comando', comando: '/cola', texto: '/cola' } } })
    expect(cola.json.input).toEqual({ clase: 'comando', comando: '/cola' })
  })
})

describe('nodo 03: armar turno evidencia', () => {
  const nodes = { 'Preparar turno': { chatId: '9' } }
  it('201 → input evidencia', () => {
    const [out] = runCodeNode('03-armar-turno-evidencia.js', {
      json: { statusCode: 201, body: { id: 1, folio: 'E-0001', processed: true, detalle: { transcription: 'x', vision_description: null, entities: [] } } },
      nodes,
    })
    expect(out.json.input.clase).toBe('evidencia')
    expect(out.json.input.evidencia.folio).toBe('E-0001')
  })
  it('403 → respuestaDirecta silencio', () => {
    const [out] = runCodeNode('03-armar-turno-evidencia.js', { json: { statusCode: 403, body: {} }, nodes })
    expect(out.json.respuestaDirecta.responder).toBe(false)
  })
  it('error → respuestaDirecta fallback', () => {
    const [out] = runCodeNode('03-armar-turno-evidencia.js', { json: { error: 'ECONNREFUSED' }, nodes })
    expect(out.json.respuestaDirecta.responder).toBe(true)
    expect(out.json.respuestaDirecta.texto).toMatch(/no pude guardar/i)
  })
})

describe('nodo 02: armar respuesta v2', () => {
  const nodes = { 'Preparar turno': { chatId: '9' } }
  it('turno con botones → inline keyboard en filas de 3', () => {
    const botones = [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' },
    ]
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 200, body: { texto: 'elegí', botones, estado: 'x' } }, nodes,
    })
    expect(out.json.responder).toBe(true)
    expect(out.json.reply_markup.inline_keyboard).toEqual([
      [{ text: 'A', callback_data: 'a' }, { text: 'B', callback_data: 'b' }, { text: 'C', callback_data: 'c' }],
      [{ text: 'D', callback_data: 'd' }],
    ])
  })
  it('sin botones → sin reply_markup', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 200, body: { texto: 'ok', botones: [], estado: 'inicio' } }, nodes,
    })
    expect(out.json.reply_markup).toBeUndefined()
  })
  it('respuestaDirecta pasa tal cual', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { respuestaDirecta: { responder: false, chatId: '9' } }, nodes,
    })
    expect(out.json.responder).toBe(false)
  })
  it('ayuda pasa con texto', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { camino: 'ayuda', chatId: '9', texto: 'ayuda...' }, nodes,
    })
    expect(out.json).toMatchObject({ responder: true, chatId: '9', texto: 'ayuda...' })
  })
  it('403 del turno → silencio; error → fallback', () => {
    const [s] = runCodeNode('02-armar-respuesta.js', { json: { statusCode: 403, body: {} }, nodes })
    expect(s.json.responder).toBe(false)
    const [e] = runCodeNode('02-armar-respuesta.js', { json: { error: 'boom' }, nodes })
    expect(e.json.texto).toMatch(/falló|no pude/i)
  })
  it('trunca a 4000', () => {
    const [out] = runCodeNode('02-armar-respuesta.js', {
      json: { statusCode: 200, body: { texto: 'a'.repeat(5000), botones: [], estado: 'x' } }, nodes,
    })
    expect(out.json.texto.length).toBeLessThanOrEqual(4000)
  })
})
```

- [ ] **Step 2: Implementar los tres nodos** conforme a los contratos de los tests (01 y 03 nuevos; 02 reescrito; AYUDA menciona /start /cola /idea y qué mandar). Borrar `01-preparar-evidencia.js`.
- [ ] **Step 3: Suite completa** — PASS
- [ ] **Step 4: Commit** — `git add n8n/src/ core-api/tests/n8n-nodes.test.js && git commit -m "feat(n8n): nodos conversacionales con teclado inline"`

---

### Task 4: Workflow v2

**Files:**
- Modify: `n8n/build-workflow.mjs`, regenerar `n8n/workflow.json`
- Modify: `core-api/tests/n8n-workflow.test.js`

**Interfaces:**
- Topología: `Webhook Telegram → ACK → Preparar turno → Switch camino` (3 salidas por `$json.camino`: `evidencia` / `turno` / `ayuda`):
  - `evidencia` → `Persistir evidencia` (HTTP como B2: header identidad, fullResponse, neverError true, onError continue, timeout 120s) → `Armar turno evidencia` (Code 03) → `¿Turno directo?` (IF `$json.respuestaDirecta` vacío → true va a `Turno del agente`; false va a `Armar respuesta`)
  - `turno` → `Turno del agente` (HTTP POST `{{$env.CORE_API_URL}}/api/agent/next-turn`, header `X-Telegram-Chat-Id: {{$json.chatId}}`, body `={{ JSON.stringify({input: $json.input}) }}`, fullResponse, neverError true, onError continue, timeout 120s) → `Armar respuesta`
  - `ayuda` → `Armar respuesta`
  - `Armar respuesta → ¿Responder? → Enviar por Telegram` (sendMessage body ahora `={{ JSON.stringify(Object.assign({chat_id: $json.chatId, text: $json.texto}, $json.reply_markup ? {reply_markup: $json.reply_markup} : {})) }}`)
- Switch por string `$json.camino` con 3 reglas (patrón switchRule del generador HSE).
- Test de estructura actualizado: nodos esperados = ['Webhook Telegram','ACK','Preparar turno','Switch camino','Persistir evidencia','Armar turno evidencia','¿Turno directo?','Turno del agente','Armar respuesta','¿Responder?','Enviar por Telegram']; conexiones válidas; `Turno del agente` con header identidad + fullResponse + neverError true; jsCode de 'Preparar turno' contiene '/cola'.

- [ ] **Step 1: RED** (test de estructura actualizado falla)
- [ ] **Step 2: Implementar generador**, `node n8n/build-workflow.mjs`
- [ ] **Step 3: Suite completa** — PASS; `git status --short n8n/` limpio tras re-build
- [ ] **Step 4: Commit** — `git add n8n/build-workflow.mjs n8n/workflow.json core-api/tests/n8n-workflow.test.js && git commit -m "feat(n8n): workflow conversacional v2 con turno del agente"`

---

### Task 5: Guía de uso y cierre

**Files:**
- Modify: `README.md`

**Interfaces:** README refleja el flujo conversacional completo (estado → Plan C2; sección "Probar" ampliada: texto libre crea idea con botones; aprobar/refinar/programar desde el teléfono; /cola; /idea <texto>; nota TZ_OFFSET_MINUTES en .env si no estás en Argentina). `.env.example`: agregar `TZ_OFFSET_MINUTES=-180` comentado con explicación.

- [ ] **Step 1: Aplicar edits** (estado `Plan C2 (conversación por Telegram)`; sección Probar reescrita; env example)
- [ ] **Step 2: Suite completa** — PASS
- [ ] **Step 3: Commit** — `git add README.md .env.example && git commit -m "docs: guia conversacional y zona horaria"`

---

## Self-Review del plan (ejecutada)

1. **Cobertura:** spec §5 completo vía Telegram (botones inline, feedback, comandos, nunca silencio incl. fallback del puente [deuda B2 saldada], silencio administrativo preservado); hallazgos C1 aplicados (sin parse_mode, botones re-emitidos no incluido → registrado como mejora v1.5).
2. **Placeholders:** Tasks 3-4 delegan implementación con contratos de test exhaustivos (patrón validado en C1-T5).
3. **Consistencia:** payload puente↔nodo 01↔next-turn input↔respuesta↔sendMessage verificada contra código C1/B2 real; `camino` switch = 3 valores exactos.
