// Entrada: respuesta full de "Persistir evidencia" ({statusCode, body} o {error})
const r = $json
const chatId = $('Preparar turno').first().json.chatId
const status = r.statusCode
const body = r.body || {}

if (status === 403) {
  // silencio administrativo: remitente no autorizado
  return [{ json: { chatId, respuestaDirecta: { responder: false, chatId } } }]
}

if (status !== 201 || !body.folio) {
  return [{ json: { chatId, respuestaDirecta: {
    responder: true,
    chatId,
    texto: '⚠️ Ahora mismo no pude guardar tu evidencia. No la perdiste: mandala de nuevo en unos minutos.',
  } } }]
}

const det = body.detalle || {}
const evidencia = {
  id: body.id,
  folio: body.folio,
  processed: body.processed,
  detalle: {
    transcription: det.transcription ?? null,
    vision_description: det.vision_description ?? null,
    entities: det.entities || [],
  },
}

return [{ json: { chatId, input: { clase: 'evidencia', evidencia } } }]
