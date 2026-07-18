import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

const NODOS_ESPERADOS = [
  'Webhook Telegram', 'ACK', 'Preparar turno', 'Switch camino',
  'Persistir evidencia', 'Armar turno evidencia', '¿Turno directo?',
  'Turno del agente', 'Redimir invitacion', 'Armar unirme',
  'Armar respuesta', '¿Responder?', 'Enviar por Telegram',
]

describe('workflow de n8n', () => {
  it('el build genera un workflow válido y consistente (topología v2 conversacional)', () => {
    execFileSync('node', [path.join(ROOT, 'n8n/build-workflow.mjs')])
    const wf = JSON.parse(readFileSync(path.join(ROOT, 'n8n/workflow.json'), 'utf8'))
    const names = wf.nodes.map((n) => n.name)

    for (const esperado of NODOS_ESPERADOS) {
      expect(names, `falta el nodo ${esperado}`).toContain(esperado)
    }
    expect(names).toHaveLength(NODOS_ESPERADOS.length)

    // toda conexión sale de un nodo existente y apunta a nodos existentes
    for (const [from, conf] of Object.entries(wf.connections)) {
      expect(names).toContain(from)
      for (const salidas of conf.main) {
        for (const destino of salidas || []) expect(names).toContain(destino.node)
      }
    }

    // el código de los nodos Code es el de src/ (fuente única)
    const preparar = wf.nodes.find((n) => n.name === 'Preparar turno')
    expect(preparar.parameters.jsCode).toContain('/cola')

    const armarTurnoEvidencia = wf.nodes.find((n) => n.name === 'Armar turno evidencia')
    expect(armarTurnoEvidencia.parameters.jsCode).toContain('respuestaDirecta')

    const armarRespuesta = wf.nodes.find((n) => n.name === 'Armar respuesta')
    expect(armarRespuesta.parameters.jsCode).toContain('silencio administrativo')

    // Switch camino: 4 salidas por $json.camino (evidencia / turno / ayuda / unirme)
    const switchCamino = wf.nodes.find((n) => n.name === 'Switch camino')
    expect(switchCamino.type).toBe('n8n-nodes-base.switch')
    const reglas = switchCamino.parameters.rules.values
    const caminos = reglas.map((r) => r.conditions.conditions[0].rightValue)
    expect(caminos).toEqual(['evidencia', 'turno', 'ayuda', 'unirme'])
    for (const regla of reglas) {
      expect(regla.conditions.conditions[0].leftValue).toBe('={{ $json.camino }}')
    }

    // el Switch conecta cada camino a su nodo correspondiente
    const conexionesSwitch = wf.connections['Switch camino'].main
    expect(conexionesSwitch[0].map((d) => d.node)).toContain('Persistir evidencia')
    expect(conexionesSwitch[1].map((d) => d.node)).toContain('Turno del agente')
    expect(conexionesSwitch[2].map((d) => d.node)).toContain('Armar respuesta')
    expect(conexionesSwitch[3].map((d) => d.node)).toContain('Redimir invitacion')

    // Persistir evidencia y Turno del agente: header de identidad, fullResponse, neverError, onError continue
    for (const nombre of ['Persistir evidencia', 'Turno del agente']) {
      const nodo = wf.nodes.find((n) => n.name === nombre)
      expect(JSON.stringify(nodo.parameters), `${nombre} manda X-Telegram-Chat-Id`).toContain('X-Telegram-Chat-Id')
      expect(nodo.parameters.options.response.response.fullResponse, `${nombre} fullResponse`).toBe(true)
      expect(nodo.parameters.options.response.response.neverError, `${nombre} neverError`).toBe(true)
      expect(nodo.onError, `${nombre} onError`).toBe('continueRegularOutput')
      expect(nodo.parameters.options.timeout).toBe(120000)
    }

    // Turno del agente pega al endpoint correcto con el body correcto
    const turnoDelAgente = wf.nodes.find((n) => n.name === 'Turno del agente')
    expect(turnoDelAgente.parameters.url).toBe('={{ $env.CORE_API_URL }}/api/agent/next-turn')
    expect(turnoDelAgente.parameters.jsonBody).toBe('={{ JSON.stringify({input: $json.input}) }}')

    // SEGURIDAD: "Redimir invitacion" es la ÚNICA llamada HTTP de todo el workflow sin
    // header de identidad — a propósito, es la ruta pública. Debe seguir teniendo los
    // mismos flags de resiliencia que las demás llamadas a core-api (fullResponse,
    // neverError, onError continue), pero con timeout corto (consulta local, no IA).
    const redimirInvitacion = wf.nodes.find((n) => n.name === 'Redimir invitacion')
    expect(redimirInvitacion.type).toBe('n8n-nodes-base.httpRequest')
    expect(redimirInvitacion.parameters.url).toBe('={{ $env.CORE_API_URL }}/api/invitations/redeem')
    expect(
      JSON.stringify(redimirInvitacion.parameters.headerParameters),
      'Redimir invitacion NO debe mandar X-Telegram-Chat-Id — es la ruta pública sin auth'
    ).not.toContain('X-Telegram-Chat-Id')
    // SEGURIDAD: sin chat_id que autenticar, el secreto interno compartido con core-api
    // es la única prueba de que quien llama es este pipeline de n8n (cierra el hallazgo
    // de secuestro de cuenta por chatId falsificado en /redeem).
    const headerSecreto = redimirInvitacion.parameters.headerParameters.parameters.find(
      (p) => p.name === 'X-Internal-Secret'
    )
    expect(headerSecreto, 'Redimir invitacion debe mandar X-Internal-Secret').toBeTruthy()
    expect(headerSecreto.value).toBe('={{ $env.INTERNAL_API_SECRET }}')
    expect(redimirInvitacion.parameters.jsonBody).toBe(
      '={{ JSON.stringify({code: $json.code, chatId: $json.chatId, nombre: $json.nombre}) }}'
    )
    expect(redimirInvitacion.parameters.options.response.response.fullResponse).toBe(true)
    expect(redimirInvitacion.parameters.options.response.response.neverError).toBe(true)
    expect(redimirInvitacion.onError).toBe('continueRegularOutput')
    expect(redimirInvitacion.parameters.options.timeout).toBe(30000)

    // todas las demás llamadas HTTP a core-api SÍ deben mandar el header de identidad
    // (confirma que "Redimir invitacion" es la excepción deliberada, no un olvido general)
    for (const nombre of ['Persistir evidencia', 'Turno del agente']) {
      const nodo = wf.nodes.find((n) => n.name === nombre)
      expect(JSON.stringify(nodo.parameters.headerParameters)).toContain('X-Telegram-Chat-Id')
    }

    // Redimir invitacion -> Armar unirme -> converge directo en ¿Responder? (no pasa por Armar respuesta)
    expect(wf.connections['Redimir invitacion'].main[0].map((d) => d.node)).toContain('Armar unirme')
    expect(wf.connections['Armar unirme'].main[0].map((d) => d.node)).toContain('¿Responder?')
    const armarUnirme = wf.nodes.find((n) => n.name === 'Armar unirme')
    expect(armarUnirme.parameters.jsCode).toContain('responder')

    // ¿Turno directo?: sin respuestaDirecta -> Turno del agente; con respuestaDirecta -> Armar respuesta
    const turnoDirecto = wf.nodes.find((n) => n.name === '¿Turno directo?')
    expect(turnoDirecto.type).toBe('n8n-nodes-base.if')
    const conexionesTurnoDirecto = wf.connections['¿Turno directo?'].main
    expect(conexionesTurnoDirecto[0].map((d) => d.node)).toContain('Turno del agente')
    expect(conexionesTurnoDirecto[1].map((d) => d.node)).toContain('Armar respuesta')

    // Armar turno evidencia -> ¿Turno directo?
    expect(wf.connections['Armar turno evidencia'].main[0].map((d) => d.node)).toContain('¿Turno directo?')

    // ¿Responder? -> Enviar por Telegram (true); false no conecta (silencio administrativo)
    const responder = wf.connections['¿Responder?'].main
    expect(responder[0].map((d) => d.node)).toContain('Enviar por Telegram')

    // Enviar por Telegram: body con reply_markup condicional
    const enviar = wf.nodes.find((n) => n.name === 'Enviar por Telegram')
    expect(enviar.parameters.jsonBody).toContain('Object.assign')
    expect(enviar.parameters.jsonBody).toContain('reply_markup')
    expect(enviar.onError).toBe('continueRegularOutput')
    expect(enviar.parameters.options.timeout).toBe(30000)
  })
})
