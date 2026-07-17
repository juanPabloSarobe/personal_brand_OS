import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeTestApp } from './helpers.js'
import { nextTurn } from '../src/agent/next-turn.js'
import { getSession, setSession } from '../src/services/sessions.js'

const llmRouter = (respuestas) => {
  let i = 0
  return async (_u, opts) => {
    const body = JSON.parse(opts.body)
    const content = typeof respuestas === 'function' ? respuestas(body) : respuestas[i++]
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  }
}

function setup({ profiles = 1 } = {}) {
  const { db } = makeTestApp()
  process.env.GROQ_API_KEY = 'gsk-test'
  const user = db.prepare("SELECT * FROM users WHERE telegram_chat_id='111'").get()
  const ids = []
  for (let i = 0; i < profiles; i++) {
    const pid = db.prepare('INSERT INTO brand_profiles (name, slug) VALUES (?, ?)')
      .run(i === 0 ? 'Juan Pablo' : 'SkyTrace', i === 0 ? 'jp' : 'sky').lastInsertRowid
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(user.id, pid)
    const li = db.prepare("SELECT id FROM channels WHERE code='linkedin'").get().id
    db.prepare("INSERT INTO profile_channels (profile_id, channel_id, status) VALUES (?, ?, 'conectado')").run(pid, li)
    ids.push(pid)
  }
  const evId = db.prepare(
    "INSERT INTO evidence (user_id, type, text_content, transcription) VALUES (?, 'audio', NULL, 'probamos el dron')"
  ).run(user.id).lastInsertRowid
  const evidencia = { id: evId, folio: 'E-0001', processed: true, detalle: { transcription: 'probamos el dron', vision_description: null, entities: [] } }
  return { db, user, ids, evidencia }
}

describe('next-turn', () => {
  it('evidencia → propone idea con botones', async () => {
    const { db, user, evidencia } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, {
      fetchImpl: llmRouter(['{"titulo": "Vuelo exitoso", "resumen": "contarlo"}']),
    })
    expect(res.estado).toBe('proponiendo_idea')
    expect(res.texto).toContain('Vuelo exitoso')
    expect(res.botones.map((b) => b.id)).toEqual(['idea_desarrollar', 'idea_guardar', 'idea_descartar'])
  })

  it('con un solo perfil saltea la elección y redacta directo', async () => {
    const { db, user, evidencia } = setup()
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']) })
    const res = await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, {
      fetchImpl: llmRouter(['Hoy probamos el dron y salió perfecto.']),
    })
    expect(res.estado).toBe('refinando_boceto')
    expect(res.texto).toContain('Hoy probamos el dron')
    expect(res.botones.map((b) => b.id)).toEqual(['boceto_aprobar', 'boceto_otra', 'boceto_descartar'])
  })

  it('con dos perfiles ofrece elegir', async () => {
    const { db, user, evidencia } = setup({ profiles: 2 })
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']) })
    const res = await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llmRouter([]) })
    expect(res.estado).toBe('eligiendo_perfiles')
    const ids = res.botones.map((b) => b.id)
    expect(ids).toContain('perfil_ambas')
    expect(ids.filter((i) => i.startsWith('perfil_')).length).toBe(3)
  })

  it('feedback de texto refina el boceto', async () => {
    const { db, user, evidencia } = setup()
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']) })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl: llmRouter(['borrador 1']) })
    const res = await nextTurn(db, user, '111', { clase: 'texto', texto: 'más técnico' }, { fetchImpl: llmRouter(['borrador 2 técnico']) })
    expect(res.texto).toContain('borrador 2 técnico')
    expect(res.estado).toBe('refinando_boceto')
  })

  it('aprobar → programando → prog_cola crea versiones aprobadas', async () => {
    const { db, user, evidencia } = setup()
    const fetchImpl = llmRouter((body) => {
      const s = JSON.stringify(body.messages)
      if (s.includes('proponer') || s.includes('evidencia capturada') || s.includes('Evidencia')) {
        if (body.response_format) {
          if (s.includes('Adaptá') || s.includes('adaptado')) return '{"texto": "adaptado", "hashtags": "#a"}'
          return '{"titulo": "T", "resumen": null}'
        }
      }
      if (body.response_format) return '{"texto": "adaptado", "hashtags": "#a"}'
      return 'borrador'
    })
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl })
    const prog = await nextTurn(db, user, '111', { clase: 'boton', boton: 'boceto_aprobar' }, { fetchImpl })
    expect(prog.estado).toBe('programando')
    const fin = await nextTurn(db, user, '111', { clase: 'boton', boton: 'prog_cola' }, { fetchImpl })
    expect(fin.estado).toBe('inicio')
    const versiones = db.prepare('SELECT status, format_code, hashtags FROM channel_versions').all()
    expect(versiones.length).toBeGreaterThan(0)
    expect(versiones.every((v) => v.status === 'aprobada')).toBe(true)
    expect(versiones.every((v) => v.hashtags === '#a')).toBe(true)
  })

  it('prog_maniana respeta zona horaria', async () => {
    process.env.TZ_OFFSET_MINUTES = '-180'
    const { db, user, evidencia } = setup()
    const fetchImpl = llmRouter((body) => {
      const s = JSON.stringify(body.messages)
      if (s.includes('proponer') || s.includes('evidencia capturada') || s.includes('Evidencia')) {
        if (body.response_format) {
          if (s.includes('Adaptá') || s.includes('adaptado')) return '{"texto": "adaptado", "hashtags": "#a"}'
          return '{"titulo": "T", "resumen": null}'
        }
      }
      if (body.response_format) return '{"texto": "adaptado", "hashtags": "#a"}'
      return 'borrador'
    })
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl })
    const prog = await nextTurn(db, user, '111', { clase: 'boton', boton: 'boceto_aprobar' }, { fetchImpl })
    expect(prog.estado).toBe('programando')
    const fin = await nextTurn(db, user, '111', { clase: 'boton', boton: 'prog_maniana' }, { fetchImpl })
    expect(fin.estado).toBe('inicio')
    const versiones = db.prepare('SELECT scheduled_at FROM channel_versions').all()
    expect(versiones.length).toBeGreaterThan(0)
    for (const v of versiones) {
      expect(v.scheduled_at).toMatch(/12:00:00$/)
    }
    delete process.env.TZ_OFFSET_MINUTES
  })

  it('LLM caído: fallback amable sin romper la sesión', async () => {
    const { db, user, evidencia } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, {
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'down' }),
    })
    expect(res.texto).toMatch(/guardada/i)
    expect(res.estado).toBe('inicio')
  })

  it('/cola responde pendientes', async () => {
    const { db, user } = setup()
    const res = await nextTurn(db, user, '111', { clase: 'comando', comando: '/cola' }, {})
    expect(res.texto).toBeTruthy()
    expect(res.estado).toBe('inicio')
  })

  it('/cola muestra bocetos aprobados sin canal (aprobados sin channel_versions)', async () => {
    const { db, user, ids } = setup()
    const ideaId = db.prepare(
      "INSERT INTO ideas (created_by, title, status) VALUES (?, 'Boceto sin canal', 'en_conversacion')"
    ).run(user.id).lastInsertRowid
    db.prepare(
      "INSERT INTO drafts (idea_id, profile_id, content, status) VALUES (?, ?, 'contenido', 'aprobado')"
    ).run(ideaId, ids[0])

    const res = await nextTurn(db, user, '111', { clase: 'comando', comando: '/cola' }, {})
    expect(res.texto).toContain('Aprobados sin programar')
    expect(res.texto).toContain('Boceto sin canal')
    expect(res.texto).toContain('Juan Pablo')
  })

  it('editor no puede aprobar (matriz de permisos)', async () => {
    const { db, user, ids, evidencia } = setup()
    db.prepare('UPDATE user_profile_access SET role = ? WHERE user_id = ? AND profile_id = ?')
      .run('editor', user.id, ids[0])
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, {
      fetchImpl: llmRouter(['{"titulo": "T", "resumen": null}']),
    })
    const desarrollar = await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, {
      fetchImpl: llmRouter(['borrador']),
    })
    expect(desarrollar.estado).toBe('refinando_boceto') // editor puede redactar/refinar

    const res = await nextTurn(db, user, '111', { clase: 'boton', boton: 'boceto_aprobar' }, { fetchImpl: llmRouter([]) })
    expect(res.texto).toMatch(/approver/)
    expect(res.estado).toBe('refinando_boceto')

    const draft = db.prepare('SELECT * FROM drafts').get()
    expect(draft.status).toBe('en_refinamiento')
  })

  it('reintento de programación no duplica versiones', async () => {
    const { db, user, evidencia } = setup()
    const fetchImpl = llmRouter((body) => {
      const s = JSON.stringify(body.messages)
      if (s.includes('proponer') || s.includes('evidencia capturada') || s.includes('Evidencia')) {
        if (body.response_format) {
          if (s.includes('Adaptá') || s.includes('adaptado')) return '{"texto": "adaptado", "hashtags": "#a"}'
          return '{"titulo": "T", "resumen": null}'
        }
      }
      if (body.response_format) return '{"texto": "adaptado", "hashtags": "#a"}'
      return 'borrador'
    })
    await nextTurn(db, user, '111', { clase: 'evidencia', evidencia }, { fetchImpl })
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'idea_desarrollar' }, { fetchImpl })
    const prog = await nextTurn(db, user, '111', { clase: 'boton', boton: 'boceto_aprobar' }, { fetchImpl })
    expect(prog.estado).toBe('programando')
    const sesionProgramando = getSession(db, user.id, '111')

    await nextTurn(db, user, '111', { clase: 'boton', boton: 'prog_cola' }, { fetchImpl })
    const countAfterFirst = db.prepare('SELECT COUNT(*) n FROM channel_versions').get().n
    expect(countAfterFirst).toBeGreaterThan(0)

    // Simulamos un reintento tras una falla a mitad de camino: la sesión vuelve a
    // 'programando' con los mismos datos y el usuario presiona la misma opción otra vez.
    setSession(db, user.id, '111', 'programando', sesionProgramando.data)
    await nextTurn(db, user, '111', { clase: 'boton', boton: 'prog_cola' }, { fetchImpl })
    const countAfterSecond = db.prepare('SELECT COUNT(*) n FROM channel_versions').get().n
    expect(countAfterSecond).toBe(countAfterFirst)
  })
})
