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
