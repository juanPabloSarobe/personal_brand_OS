// Entrada: POST del puente-telegram — $json.body = {chatId, tipo, texto?, comando?, caption?, filename?, content_base64?}
const b = $json.body || $json

const AYUDA = [
  '👋 Soy tu Personal Brand OS.',
  'Mandame fotos, audios, videos o texto con tus avances personales y laborales, y los archivo como evidencia procesada (transcripción, descripción y entidades).',
  '',
  'Comandos: /start — esta ayuda',
].join('\n')

if (b.tipo === 'comando') {
  return [{ json: { chatId: b.chatId, esComando: true, texto: AYUDA } }]
}

const evidencePost = {
  type: b.tipo,
  text: b.texto || null,
  filename: b.filename || null,
  content_base64: b.content_base64 || null,
  context: { origen: 'telegram', caption: b.caption || null },
}
return [{ json: { chatId: b.chatId, esComando: false, evidencePost } }]
