// Entrada: POST del puente-telegram — $json.body = {chatId, tipo, texto?, comando?, boton?, caption?, filename?, content_base64?}
const b = $json.body || $json

const AYUDA = [
  '👋 Soy tu Personal Brand OS.',
  'Mandame fotos, audios, videos o texto con tus avances personales y laborales, y armamos ideas y contenido juntos.',
  '',
  'Comandos:',
  '/start — esta ayuda',
  '/cola — ver qué tenés pendiente',
  '/idea <texto> — cargar una idea directamente',
  '/marca <nombre> — crear una marca nueva (solo admin)',
  '/invitar [rol] — generar un código para sumar a alguien (solo owner)',
  '/conectar — sumar LinkedIn o Instagram a una marca (solo owner)',
].join('\n')

if (b.tipo === 'comando' && b.comando === '/start') {
  return [{ json: { chatId: b.chatId, camino: 'ayuda', texto: AYUDA } }]
}

if (b.tipo === 'comando') {
  const comandoCompleto = b.texto || b.comando || ''
  // /unirme <código>: único comando que NO pasa por la autenticación normal — el
  // remitente todavía no existe en `users`. Se resuelve contra la ruta pública
  // POST /api/invitations/redeem (ver "Redimir invitacion" en build-workflow.mjs).
  if (comandoCompleto === '/unirme' || comandoCompleto.startsWith('/unirme ')) {
    const code = comandoCompleto.slice('/unirme'.length).trim()
    return [{ json: { chatId: b.chatId, camino: 'unirme', nombre: b.nombre || null, code } }]
  }
  return [{ json: { chatId: b.chatId, camino: 'turno', input: { clase: 'comando', comando: comandoCompleto } } }]
}

if (b.tipo === 'texto') {
  return [{ json: { chatId: b.chatId, camino: 'turno', input: { clase: 'texto', texto: b.texto } } }]
}

if (b.tipo === 'boton') {
  return [{ json: { chatId: b.chatId, camino: 'turno', input: { clase: 'boton', boton: b.boton } } }]
}

// media: foto | audio | video
const evidencePost = {
  type: b.tipo,
  text: b.texto || null,
  filename: b.filename || null,
  content_base64: b.content_base64 || null,
  context: { origen: 'telegram', caption: b.caption || null },
}
return [{ json: { chatId: b.chatId, camino: 'evidencia', evidencePost } }]
