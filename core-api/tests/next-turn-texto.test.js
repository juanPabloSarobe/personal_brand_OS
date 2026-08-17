import { describe, it, expect, beforeEach } from 'vitest'
import { makeTestApp } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'

const llm = (contents) => {
  let i = 0
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: contents[i++] } }] }) })
}

function setup() {
  const { db } = makeTestApp()
  process.env.GROQ_API_KEY = 'gsk-test'
  const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
  const pid = db.prepare("INSERT INTO brand_profiles (name, slug) VALUES ('JP','jp')").run().lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(user.id, pid)
  return { db, user }
}

describe('texto en inicio = captura', () => {
  it('crea evidencia y propone idea', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'hoy probamos el sensor nuevo' }, {
      fetchImpl: llm([
        JSON.stringify({ entidades: [] }),               // pipeline: entidades
        '{"titulo": "Sensor nuevo", "resumen": "contarlo"}', // proponer idea
      ]),
    })
    expect(res.estado).toBe('proponiendo_idea')
    expect(res.texto).toMatch(/E-\d{4}/)
    expect(res.botones.map((b) => b.id)).toContain('idea_desarrollar')
    const ev = db.prepare("SELECT * FROM evidence WHERE type='texto'").get()
    expect(ev.text_content).toBe('hoy probamos el sensor nuevo')
    expect(ev.user_id).toBe(user.id)
  })

  it('el refinado le pasa la evidencia original al LLM', async () => {
    const { db, user } = setup()
    await nextTurn(db, user, '111', { clase: 'texto', texto: 'termine de configurar el community manager' }, {
      fetchImpl: llm([JSON.stringify({ entidades: [] }), '{"titulo": "T", "resumen": null}']),
    })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llm(['borrador con 153 interacciones']) })
    let enviado = null
    const captor = async (_u, opts) => {
      enviado = opts.body
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'borrador corto' } }] }) }
    }
    await nextTurn(db, user, '111', { clase: 'texto', texto: 'no inventes datos' }, { fetchImpl: captor })
    expect(enviado).toContain('termine de configurar el community manager')
  })

  it('texto en refinando_boceto sigue siendo feedback (no crea evidencia)', async () => {
    const { db, user } = setup()
    await nextTurn(db, user, '111', { clase: 'texto', texto: 'evidencia base' }, {
      fetchImpl: llm([JSON.stringify({ entidades: [] }), '{"titulo": "T", "resumen": null}']),
    })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llm(['borrador 1']) })
    const antes = db.prepare('SELECT COUNT(*) n FROM evidence').get().n
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'más corto' }, { fetchImpl: llm(['borrador corto']) })
    expect(res.texto).toContain('borrador corto')
    expect(db.prepare('SELECT COUNT(*) n FROM evidence').get().n).toBe(antes)
  })

  it('IA caída: la evidencia queda igual (regla de oro)', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'captura resiliente' }, {
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }),
    })
    expect(res.texto).toMatch(/guardada/i)
    expect(db.prepare("SELECT COUNT(*) n FROM evidence WHERE text_content='captura resiliente'").get().n).toBe(1)
  })

  it('si el INSERT falla avisa que NO se guardó', async () => {
    const { db, user } = setup()
    db.exec('DROP TABLE evidence')
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'texto perdido' }, { fetchImpl: llm([]) })
    expect(res.texto).toMatch(/No pude guardar/)
    expect(res.estado).toBe('inicio')
    expect(res.texto).not.toMatch(/guardada/)
    expect(res.botones).toEqual([])
  })
})

describe('/idea con argumento', () => {
  it('crea la idea con ese título', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'comando', comando: '/idea Lanzar newsletter' }, {})
    expect(res.estado).toBe('proponiendo_idea')
    const idea = db.prepare("SELECT * FROM ideas WHERE title='Lanzar newsletter'").get()
    expect(idea).toBeTruthy()
  })
})
