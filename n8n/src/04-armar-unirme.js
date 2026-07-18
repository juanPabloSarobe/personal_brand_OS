// Entrada: respuesta full del HTTP "Redimir invitacion" ({statusCode, body:{ok,texto}} o {error}).
// POST /api/invitations/redeem SIEMPRE responde 200 con {ok,texto} (nunca otro status) —
// así que acá no hace falta distinguir ok:true de ok:false, el texto ya viene armado por
// core-api en ambos casos. El único caso especial es que la red falle (core-api caído,
// timeout): ahí sí conviene un fallback amable, igual que los otros nodos de armado.
const r = $json
const chatId = $('Preparar turno').first().json.chatId
const status = r.statusCode
const body = r.body || {}

if (r.error || status !== 200 || typeof body.texto !== 'string') {
  return [{ json: {
    responder: true,
    chatId,
    texto: '⚠️ Ahora mismo no pude validar tu invitación. Probá de nuevo en unos minutos con /unirme <código>.',
  } }]
}

return [{ json: { responder: true, chatId, texto: body.texto } }]
