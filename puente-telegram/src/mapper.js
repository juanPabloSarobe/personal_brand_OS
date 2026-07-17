export function mapUpdate(update) {
  const cbq = update.callback_query
  if (cbq && cbq.message && cbq.message.chat) {
    return { chatId: String(cbq.message.chat.id), tipo: 'boton', boton: cbq.data, callbackQueryId: cbq.id }
  }
  const msg = update.message
  if (!msg || !msg.chat) return null
  const chatId = String(msg.chat.id)
  const caption = msg.caption || null

  if (typeof msg.text === 'string') {
    if (msg.text.startsWith('/')) {
      return { chatId, tipo: 'comando', comando: msg.text.split(/\s+/)[0], texto: msg.text }
    }
    return { chatId, tipo: 'texto', texto: msg.text }
  }
  if (msg.voice) return { chatId, tipo: 'audio', fileId: msg.voice.file_id, filename: 'nota-de-voz.ogg', caption }
  if (msg.audio) return { chatId, tipo: 'audio', fileId: msg.audio.file_id, filename: msg.audio.file_name || 'audio.mp3', caption }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1]
    return { chatId, tipo: 'foto', fileId: best.file_id, filename: 'foto.jpg', caption }
  }
  if (msg.video) return { chatId, tipo: 'video', fileId: msg.video.file_id, filename: msg.video.file_name || 'video.mp4', caption }
  if (msg.document) {
    const mime = msg.document.mime_type || ''
    const tipo = mime.startsWith('image/') ? 'foto'
      : mime.startsWith('audio/') ? 'audio'
      : mime.startsWith('video/') ? 'video'
      : null
    if (!tipo) return null
    return { chatId, tipo, fileId: msg.document.file_id, filename: msg.document.file_name || 'archivo.bin', caption }
  }
  return null
}
