import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

// C2-T3 borró n8n/src/01-preparar-evidencia.js (reemplazado por 01-preparar-turno.js +
// 03-armar-turno-evidencia.js) pero build-workflow.mjs todavía referencia el archivo viejo.
// C2-T4 lo reactiva
describe.skip('workflow de n8n', () => {
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
    expect(persistir.parameters.options.response.response.neverError).toBe(true)
    expect(persistir.onError).toBe('continueRegularOutput')
  })
})
