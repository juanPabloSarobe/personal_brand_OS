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
