import { describe, it, expect } from 'vitest'
import { mapUpdate } from '../../puente-telegram/src/mapper.js'
import { forwardUpdate, runOnce } from '../../puente-telegram/src/bridge.js'

const deps = (fetchImpl, log = { error: () => {} }) =>
  ({ token: 'TOK', webhook: 'http://n8n:5678/webhook/telegram', fetchImpl, log })

describe('callback_query', () => {
  it('mapea botón', () => {
    const u = { update_id: 1, callback_query: { id: 'cbq9', data: 'boceto_aprobar', message: { chat: { id: 42 } } } }
    expect(mapUpdate(u)).toEqual({ chatId: '42', tipo: 'boton', boton: 'boceto_aprobar', callbackQueryId: 'cbq9' })
  })

  it('forwardUpdate responde el callback y reenvía sin callbackQueryId', async () => {
    const calls = []
    const f = async (u, opts) => { calls.push({ u, body: opts?.body && JSON.parse(opts.body) }); return { ok: true } }
    const u = { update_id: 2, callback_query: { id: 'cbq1', data: 'prog_cola', message: { chat: { id: 7 } } } }
    const res = await forwardUpdate(u, deps(f))
    expect(res.forwarded).toBe(true)
    expect(calls[0].u).toContain('/answerCallbackQuery')
    expect(calls[0].body).toEqual({ callback_query_id: 'cbq1' })
    expect(calls[1].u).toBe('http://n8n:5678/webhook/telegram')
    expect(calls[1].body).toEqual({ chatId: '7', tipo: 'boton', boton: 'prog_cola' })
  })

  it('answerCallbackQuery fallido no impide el reenvío', async () => {
    const f = async (u, opts) => {
      if (u.includes('answerCallbackQuery')) throw new Error('timeout')
      return { ok: true }
    }
    const u = { update_id: 3, callback_query: { id: 'x', data: 'd', message: { chat: { id: 7 } } } }
    expect((await forwardUpdate(u, deps(f))).forwarded).toBe(true)
  })
})

describe('fallback del puente', () => {
  it('webhook caído → sendMessage de disculpa best-effort', async () => {
    const sent = []
    const f = async (u, opts) => {
      if (u.includes('getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 5, message: { chat: { id: 9 }, text: 'hola' } },
      ] }) }
      if (u.includes('sendMessage')) { sent.push(JSON.parse(opts.body)); return { ok: true } }
      return { ok: false, status: 502 } // webhook
    }
    const next = await runOnce(0, deps(f))
    expect(next).toBe(6)
    expect(sent).toHaveLength(1)
    expect(sent[0].chat_id).toBe('9')
    expect(sent[0].text).toMatch(/No pude procesar/)
  })

  it('si también falla el sendMessage, no lanza', async () => {
    const f = async (u) => {
      if (u.includes('getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [
        { update_id: 6, message: { chat: { id: 9 }, text: 'hola' } },
      ] }) }
      throw new Error('todo caído')
    }
    await expect(runOnce(0, deps(f))).resolves.toBe(7)
  })
})
