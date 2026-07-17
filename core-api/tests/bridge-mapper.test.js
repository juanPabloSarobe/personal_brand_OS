import { describe, it, expect } from 'vitest'
import { mapUpdate } from '../../puente-telegram/src/mapper.js'

const base = { update_id: 1 }
const chat = { id: 5551234 }

describe('mapper del puente', () => {
  it('texto plano', () => {
    expect(mapUpdate({ ...base, message: { chat, text: 'probamos el sensor' } }))
      .toEqual({ chatId: '5551234', tipo: 'texto', texto: 'probamos el sensor' })
  })

  it('comando', () => {
    expect(mapUpdate({ ...base, message: { chat, text: '/start hola' } }))
      .toEqual({ chatId: '5551234', tipo: 'comando', comando: '/start', texto: '/start hola' })
  })

  it('nota de voz → audio', () => {
    expect(mapUpdate({ ...base, message: { chat, voice: { file_id: 'F1' } } }))
      .toEqual({ chatId: '5551234', tipo: 'audio', fileId: 'F1', filename: 'nota-de-voz.ogg', caption: null })
  })

  it('foto: toma la resolución más alta y conserva caption', () => {
    const message = { chat, caption: 'banco de pruebas', photo: [{ file_id: 'chica' }, { file_id: 'grande' }] }
    expect(mapUpdate({ ...base, message }))
      .toEqual({ chatId: '5551234', tipo: 'foto', fileId: 'grande', filename: 'foto.jpg', caption: 'banco de pruebas' })
  })

  it('video con nombre', () => {
    const message = { chat, video: { file_id: 'V1', file_name: 'vuelo.mp4' } }
    expect(mapUpdate({ ...base, message })).toMatchObject({ tipo: 'video', fileId: 'V1', filename: 'vuelo.mp4' })
  })

  it('documento por mime: imagen → foto; desconocido → null', () => {
    expect(mapUpdate({ ...base, message: { chat, document: { file_id: 'D1', mime_type: 'image/png', file_name: 'plano.png' } } }))
      .toMatchObject({ tipo: 'foto', filename: 'plano.png' })
    expect(mapUpdate({ ...base, message: { chat, document: { file_id: 'D2', mime_type: 'application/zip' } } })).toBeNull()
  })

  it('updates sin mensaje o no soportados → null', () => {
    expect(mapUpdate({ ...base })).toBeNull()
    expect(mapUpdate({ ...base, message: { chat, sticker: { file_id: 'S1' } } })).toBeNull()
  })
})
