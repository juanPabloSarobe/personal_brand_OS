import { readFileSync } from 'fs'

/**
 * Envía un mensaje de texto por Telegram
 * @param {string} chatId - ID del chat de Telegram
 * @param {string} text - Texto del mensaje
 * @param {Object} options - Opciones
 * @param {Function} options.fetchImpl - Implementación de fetch (opcional)
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function sendMessage(chatId, text, options = {}) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return { ok: false, reason: 'sin TELEGRAM_BOT_TOKEN' }
    }

    const fetchImpl = options.fetchImpl || fetch
    const url = `https://api.telegram.org/bot${token}/sendMessage`

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { ok: false, reason: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    return { ok: data.ok !== false }
  } catch (err) {
    return { ok: false, reason: `Error: ${err.message}` }
  }
}

/**
 * Envía una foto por Telegram
 * @param {string} chatId - ID del chat de Telegram
 * @param {string} filePath - Ruta al archivo de imagen
 * @param {string} caption - Texto de la caption
 * @param {Object} options - Opciones
 * @param {Function} options.fetchImpl - Implementación de fetch (opcional)
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function sendPhotoFile(chatId, filePath, caption, options = {}) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return { ok: false, reason: 'sin TELEGRAM_BOT_TOKEN' }
    }

    const fetchImpl = options.fetchImpl || fetch
    const url = `https://api.telegram.org/bot${token}/sendPhoto`

    // Truncar caption a 1024 caracteres (límite de Telegram)
    const truncatedCaption = caption.slice(0, 1024)

    // Leer el archivo y crear FormData con Blob
    const fileBuffer = readFileSync(filePath)
    const blob = new Blob([fileBuffer], { type: 'image/jpeg' })

    const formData = new FormData()
    formData.append('chat_id', chatId)
    formData.append('photo', blob, 'photo.jpg')
    formData.append('caption', truncatedCaption)

    const response = await fetchImpl(url, {
      method: 'POST',
      body: formData
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { ok: false, reason: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    return { ok: data.ok !== false }
  } catch (err) {
    return { ok: false, reason: `Error: ${err.message}` }
  }
}
