import { describe, it, expect } from 'vitest'
import { config, fetchUpdates, downloadFile, forwardUpdate, runOnce } from '../../puente-telegram/src/bridge.js'

const deps = (fetchImpl, log = { error: () => {} }) =>
  ({ token: 'TOK', webhook: 'http://n8n:5678/webhook/telegram', fetchImpl, log })

describe('puente-telegram', () => {
  it('config exige las dos env vars', () => {
    expect(() => config({})).toThrow(/TELEGRAM_BOT_TOKEN/)
    expect(config({ TELEGRAM_BOT_TOKEN: 't', N8N_WEBHOOK_URL: 'w' })).toEqual({ token: 't', webhook: 'w' })
  })

  it('fetchUpdates pega a getUpdates con offset y timeout', async () => {
    let url
    const f = async (u) => { url = u; return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 7 }] }) } }
    const res = await fetchUpdates(5, deps(f))
    expect(url).toBe('https://api.telegram.org/botTOK/getUpdates?timeout=25&offset=5')
    expect(res).toEqual([{ update_id: 7 }])
  })

  it('downloadFile resuelve getFile y baja el binario', async () => {
    const calls = []
    const f = async (u) => {
      calls.push(u)
      if (u.includes('getFile')) return { ok: true, json: async () => ({ result: { file_path: 'voice/f.ogg' } }) }
      return { ok: true, arrayBuffer: async () => Buffer.from('binario') }
    }
    const buf = await downloadFile('F1', deps(f))
    expect(calls[1]).toBe('https://api.telegram.org/file/botTOK/voice/f.ogg')
    expect(buf.toString()).toBe('binario')
  })

  it('forwardUpdate arma el payload con content_base64 y postea al webhook', async () => {
    let posted
    const f = async (u, opts) => {
      if (u.includes('getFile')) return { ok: true, json: async () => ({ result: { file_path: 'p/f.ogg' } }) }
      if (u.includes('/file/')) return { ok: true, arrayBuffer: async () => Buffer.from('audio') }
      posted = { url: u, body: JSON.parse(opts.body) }
      return { ok: true }
    }
    const update = { update_id: 1, message: { chat: { id: 9 }, voice: { file_id: 'F1' } } }
    const res = await forwardUpdate(update, deps(f))
    expect(res.forwarded).toBe(true)
    expect(posted.url).toBe('http://n8n:5678/webhook/telegram')
    expect(posted.body).toMatchObject({ chatId: '9', tipo: 'audio', filename: 'nota-de-voz.ogg' })
    expect(posted.body.content_base64).toBe(Buffer.from('audio').toString('base64'))
    expect(posted.body.fileId).toBeUndefined()
  })

  it('update no mapeable no se reenvía', async () => {
    const res = await forwardUpdate({ update_id: 2 }, deps(async () => { throw new Error('no debería llamar') }))
    expect(res).toEqual({ forwarded: false, reason: 'sin_mapeo' })
  })

  it('runOnce avanza el offset y un update fallido no corta el batch', async () => {
    const errors = []
    const f = async (u, opts) => {
      if (u.includes('getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 10, message: { chat: { id: 1 }, text: 'falla' } },
        { update_id: 11, message: { chat: { id: 1 }, text: 'anda' } },
      ] }) }
      const body = JSON.parse(opts.body)
      if (body.texto === 'falla') return { ok: false, status: 500 }
      return { ok: true }
    }
    const next = await runOnce(3, deps(f, { error: (m) => errors.push(m) }))
    expect(next).toBe(12)
    expect(errors).toHaveLength(1)
  })
})
