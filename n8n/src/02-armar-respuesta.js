// Entrada: respuesta full del HTTP next-turn ({statusCode, body:{texto, botones, estado}} o {error}),
// o pass-through de "Armar turno evidencia" ({respuestaDirecta:{...}}), o ayuda local de
// "Preparar turno" ({camino:'ayuda', chatId, texto}).
const r = $json

function chatIdDelTurno() {
  return $('Preparar turno').first().json.chatId
}

function filasDeTeclado(botones) {
  const filas = []
  for (let i = 0; i < botones.length; i += 3) {
    filas.push(botones.slice(i, i + 3).map((b) => ({ text: b.label, callback_data: b.id })))
  }
  return filas
}

function truncar(texto) {
  if (typeof texto !== 'string') return texto
  return texto.length > 4000 ? texto.slice(0, 3997) + '…' : texto
}

// pass-through: el nodo "Armar turno evidencia" ya resolvió la respuesta (403/error de persistencia)
if (r.respuestaDirecta) {
  return [{ json: { ...r.respuestaDirecta, texto: truncar(r.respuestaDirecta.texto) } }]
}

// ayuda local (/start) resuelta en "Preparar turno"
if (r.camino === 'ayuda') {
  return [{ json: { responder: true, chatId: r.chatId, texto: truncar(r.texto) } }]
}

const chatId = r.chatId || chatIdDelTurno()
const status = r.statusCode
const body = r.body || {}

if (status === 403) {
  // silencio administrativo: remitente no autorizado
  return [{ json: { responder: false, chatId } }]
}

if (r.error || status !== 200) {
  return [{ json: {
    responder: true,
    chatId,
    texto: '⚠️ Algo falló de mi lado. No pude procesar tu mensaje — probá de nuevo en unos minutos.',
  } }]
}

const salida = { responder: true, chatId, texto: truncar(body.texto) }
if (Array.isArray(body.botones) && body.botones.length) {
  salida.reply_markup = { inline_keyboard: filasDeTeclado(body.botones) }
}

return [{ json: salida }]
