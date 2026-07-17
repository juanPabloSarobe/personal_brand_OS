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

// IF booleano: `leftExpr` (resuelve a true/false) — usado por "¿Responder?" (patrón B2-fix)
const ifNodeBoolean = (name, leftExpr, position) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2,
  position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        leftValue: leftExpr,
        rightValue: true,
        operator: { type: 'boolean', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
})

// IF por comparación de string: usado por "¿Turno directo?" (más portable entre versiones de n8n
// que el operador object.notExists)
const ifNodeString = (name, leftExpr, rightValue, position) => ({
  name,
  type: 'n8n-nodes-base.if',
  typeVersion: 2,
  position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{
        leftValue: leftExpr,
        rightValue,
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  },
})

// Regla del Switch: compara $json.camino contra un valor fijo y renombra la salida
const switchRule = (camino) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{
      leftValue: '={{ $json.camino }}',
      rightValue: camino,
      operator: { type: 'string', operation: 'equals' },
    }],
    combinator: 'and',
  },
  renameOutput: true,
  outputKey: camino,
})

// Switch camino: 3 salidas fijas por $json.camino (evidencia / turno / ayuda). "Preparar turno"
// siempre setea uno de estos tres valores, así que no hace falta una salida extra de fallback.
const switchNode = (name, caminos, position) => ({
  name,
  type: 'n8n-nodes-base.switch',
  typeVersion: 3,
  position,
  parameters: {
    mode: 'rules',
    rules: { values: caminos.map(switchRule) },
    options: { fallbackOutput: 'none' },
  },
})

// HTTP hacia core-api: header de identidad, fullResponse + neverError (para que el nodo Code
// siguiente pueda leer status/error sin que n8n corte la ejecución), timeout largo (pipeline de IA).
const httpCoreApi = (name, { url, jsonBody }, position) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  onError: 'continueRegularOutput',
  parameters: {
    method: 'POST',
    url,
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'X-Telegram-Chat-Id', value: '={{ $json.chatId }}' },
      { name: 'Content-Type', value: 'application/json' },
    ] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    options: {
      timeout: 120000,
      response: { response: { fullResponse: true, neverError: true } },
    },
  },
})

const nodes = [
  {
    name: 'Webhook Telegram',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, 400],
    webhookId: 'pbos-telegram',
    parameters: { httpMethod: 'POST', path: 'telegram', responseMode: 'responseNode', options: {} },
  },
  {
    // ACK inmediato al puente: la respuesta real sale por "Enviar por Telegram" (nunca silencio por latencia)
    name: 'ACK',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [180, 400],
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify({ok: true}) }}', options: {} },
  },
  codeNode('Preparar turno', '01-preparar-turno.js', [360, 400]),
  switchNode('Switch camino', ['evidencia', 'turno', 'ayuda'], [560, 400]),

  // camino "evidencia"
  httpCoreApi('Persistir evidencia', {
    url: '={{ $env.CORE_API_URL }}/api/evidence',
    jsonBody: '={{ JSON.stringify($json.evidencePost) }}',
  }, [780, 220]),
  codeNode('Armar turno evidencia', '03-armar-turno-evidencia.js', [1000, 220]),
  ifNodeString('¿Turno directo?', '={{ $json.respuestaDirecta ? "si" : "no" }}', 'no', [1220, 220]),

  // camino "turno" (y salida "no respuestaDirecta" de ¿Turno directo?)
  httpCoreApi('Turno del agente', {
    url: '={{ $env.CORE_API_URL }}/api/agent/next-turn',
    jsonBody: '={{ JSON.stringify({input: $json.input}) }}',
  }, [780, 400]),

  // confluencia: turno / ayuda / respuestaDirecta de evidencia
  codeNode('Armar respuesta', '02-armar-respuesta.js', [1440, 400]),
  ifNodeBoolean('¿Responder?', '={{ $json.responder }}', [1620, 400]),
  {
    name: 'Enviar por Telegram',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1840, 400],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: '=https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify(Object.assign({chat_id: $json.chatId, text: $json.texto}, $json.reply_markup ? {reply_markup: $json.reply_markup} : {})) }}',
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
  ['ACK', [main('Preparar turno')]],
  ['Preparar turno', [main('Switch camino')]],
  ['Switch camino', [
    { ...main('Persistir evidencia'), _out: 0 },  // evidencia
    { ...main('Turno del agente'), _out: 1 },     // turno
    { ...main('Armar respuesta'), _out: 2 },      // ayuda
  ]],
  ['Persistir evidencia', [main('Armar turno evidencia')]],
  ['Armar turno evidencia', [main('¿Turno directo?')]],
  ['¿Turno directo?', [
    { ...main('Turno del agente'), _out: 0 },  // true: sin respuestaDirecta -> sigue al agente
    { ...main('Armar respuesta'), _out: 1 },   // false: ya hay respuestaDirecta -> arma y listo
  ]],
  ['Turno del agente', [main('Armar respuesta')]],
  ['Armar respuesta', [main('¿Responder?')]],
  ['¿Responder?', [
    { ...main('Enviar por Telegram'), _out: 0 },  // true
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
