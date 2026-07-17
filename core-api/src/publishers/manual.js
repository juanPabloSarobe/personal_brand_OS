import { sendMessage, sendPhotoFile } from '../services/telegram.js'

const INSTRUCCIONES = {
  wa_status: 'Subilo a tu estado de WhatsApp 👆',
}

function instruccionPara(channelCode) {
  return INSTRUCCIONES[channelCode] || `Listo para pegar en ${channelCode} 👆`
}

function armarTexto(version, channelCode) {
  let texto = version.text_content || ''
  if (version.hashtags) texto += `\n\n${version.hashtags}`
  texto += `\n\n${instruccionPara(channelCode)}`
  return texto
}

/**
 * Paquete manual: manda el contenido listo para publicar al chat del creador
 * de la idea (Telegram), con instrucción específica por canal.
 * @param {{version: object, channelCode: string, creatorChatId: string}} ctx
 * @param {{fetchImpl?: Function}} deps
 * @returns {Promise<{ok:true, manual:true} | {ok:false, retryable:true, error:string}>}
 */
export async function publicarManual(ctx, deps = {}) {
  const { version, channelCode, creatorChatId } = ctx
  const texto = armarTexto(version, channelCode)

  const resultado = version.media_path
    ? await sendPhotoFile(creatorChatId, version.media_path, texto, deps)
    : await sendMessage(creatorChatId, texto, deps)

  if (!resultado.ok) {
    return { ok: false, retryable: true, error: resultado.reason }
  }
  return { ok: true, manual: true }
}
