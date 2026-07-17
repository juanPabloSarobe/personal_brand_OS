import path from 'node:path'
import { mkdirSync } from 'node:fs'
import crypto from 'node:crypto'
import { getSession, setSession, clearSession } from '../services/sessions.js'
import {
  createIdea, setIdeaStatus, linkIdeaProfiles, createDraft, updateDraft,
  setDraftStatus, createChannelVersion, pendingFor, connectedChannels,
  crearPerfilConWaStatus, conectarCanal,
} from '../services/editorial.js'
import { proponerIdea, redactarBoceto, refinarBoceto, adaptarVersion } from '../services/redactor.js'
import { renderChannelImage, FORMAT_DIMENSIONS } from '../services/imagen.js'
import { processEvidence } from '../services/evidence-pipeline.js'
import { entitiesFor } from '../services/entities-store.js'
import { AiError } from '../ai/client.js'
import { can } from '../permissions.js'

const BOTONES_IDEA = [
  { id: 'idea_desarrollar', label: '✍️ Desarrollar' },
  { id: 'idea_guardar', label: '📥 Solo guardar' },
  { id: 'idea_descartar', label: '🗑 Descartar' },
]
const BOTONES_BOCETO = [
  { id: 'boceto_aprobar', label: '✅ Aprobar' },
  { id: 'boceto_otra', label: '🔄 Otra versión' },
  { id: 'boceto_descartar', label: '🗑 Descartar' },
]
const BOTONES_PROG = [
  { id: 'prog_ahora', label: '🚀 Ahora' },
  { id: 'prog_maniana', label: '🌅 Mañana 9hs' },
  { id: 'prog_cola', label: '⏳ A la cola' },
]

// Alfabeto seguro para códigos de invitación: sin 0/O/1/I (se confunden al dictar/leer).
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROLES_VALIDOS = ['owner', 'editor', 'approver']

// /conectar: botones de canal y, por canal, la lista ordenada de campos que se piden
// uno por uno (nunca todos juntos) + el texto que se muestra al pedir cada campo.
const BOTONES_CANAL = [
  { id: 'conectar_linkedin', label: '💼 LinkedIn' },
  { id: 'conectar_instagram', label: '📸 Instagram' },
]
const NOMBRE_CANAL = { linkedin: 'LinkedIn', instagram: 'Instagram' }
const CAMPOS_CANAL = {
  linkedin: ['access_token', 'person_urn'],
  instagram: ['access_token', 'ig_user_id'],
}
const CAMPO_PROMPT = {
  linkedin: {
    access_token: 'Pegame el access_token de LinkedIn (lo sacás de tu app en linkedin.com/developers)',
    person_urn: 'Ahora pasame el person_urn de LinkedIn (tu identificador, algo como urn:li:person:XXXXXXX, en la sección "Sign In with LinkedIn" de tu app)',
  },
  instagram: {
    access_token: 'Pegame el access_token de Instagram (lo sacás de tu app en developers.facebook.com)',
    ig_user_id: 'Ahora pasame el ig_user_id de Instagram (el ID numérico de tu cuenta Business, lo ves en el Graph API Explorer)',
  },
}

// Formato propuesto por canal cuando la idea tiene una foto de evidencia disponible.
const FORMATO_CON_IMAGEN = { linkedin: 'imagen', instagram: 'feed', wa_status: 'historia' }
// Formato propuesto por canal cuando no hay imagen (solo texto). instagram/wa_status
// no tienen formato de solo-texto viable → se saltean.
const FORMATO_SOLO_TEXTO = { linkedin: 'texto' }

export async function nextTurn(db, user, chatId, input, { fetchImpl } = {}) {
  try {
    return await dispatch(db, user, chatId, input, { fetchImpl })
  } catch (err) {
    // regla de oro: jamás romper la conversación
    console.error('next-turn error:', err)
    return {
      texto: '⚠️ Algo falló de mi lado. Tu material está guardado — probá de nuevo en un rato.',
      botones: [],
      estado: (getSession(db, user.id, chatId) || { state: 'inicio' }).state,
    }
  }
}

async function dispatch(db, user, chatId, input, opts) {
  if (input.clase === 'evidencia') return handleEvidencia(db, user, chatId, input.evidencia, opts)
  if (input.clase === 'comando') return handleComando(db, user, chatId, input)
  if (input.clase === 'texto') return handleTexto(db, user, chatId, input, opts)
  if (input.clase === 'boton') return handleBoton(db, user, chatId, input, opts)
  return textoGuia(getSession(db, user.id, chatId))
}

// ---------------------------------------------------------------------------
// Helpers de lectura
// ---------------------------------------------------------------------------

function perfilesDe(db, userId) {
  return db.prepare(`
    SELECT bp.* FROM user_profile_access upa
    JOIN brand_profiles bp ON bp.id = upa.profile_id
    WHERE upa.user_id = ?
    ORDER BY bp.id
  `).all(userId)
}

function evidenciasDeIdea(db, ideaId) {
  return db.prepare(`
    SELECT e.* FROM idea_evidence ie
    JOIN evidence e ON e.id = ie.evidence_id
    WHERE ie.idea_id = ?
    ORDER BY e.id
  `).all(ideaId)
}

// primera evidencia tipo foto con archivo, vinculada a la idea (para renderizar versiones con imagen)
function fotoDeIdea(db, ideaId) {
  return db.prepare(`
    SELECT e.* FROM idea_evidence ie
    JOIN evidence e ON e.id = ie.evidence_id
    WHERE ie.idea_id = ? AND e.type = 'foto' AND e.file_path IS NOT NULL
    ORDER BY e.id LIMIT 1
  `).get(ideaId) || null
}

function nowSql(db) {
  return db.prepare("SELECT datetime('now') AS t").get().t
}

function tzOffsetMinutes() {
  const parsed = parseInt(process.env.TZ_OFFSET_MINUTES, 10)
  return Number.isFinite(parsed) ? parsed : -180
}

function tomorrowNineSql(db) {
  const offset = tzOffsetMinutes()
  return db.prepare(
    `SELECT datetime('now', '${offset} minutes', '+1 day', 'start of day', '+9 hours', '${-offset} minutes') AS t`
  ).get().t
}

function presentarBoceto(profile, content) {
  return `📝 *${profile.name}*\n\n${content}`
}

function sinPermisoEditar(profile) {
  return { texto: `🔒 No tenés permiso para editar bocetos en ${profile.name}.`, botones: BOTONES_BOCETO, estado: 'refinando_boceto' }
}

function slugify(name) {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function textoGuia(session) {
  return {
    texto: 'Mandame una foto, un audio o un texto para capturar una idea. Escribí /cola para ver qué tenés pendiente.',
    botones: [],
    estado: session?.state || 'inicio',
  }
}

// ---------------------------------------------------------------------------
// evidencia → propone idea
// ---------------------------------------------------------------------------

async function handleEvidencia(db, user, chatId, evidencia, opts) {
  const row = evidencia?.id
    ? db.prepare('SELECT * FROM evidence WHERE id = ? AND user_id = ?').get(evidencia.id, user.id)
    : null
  if (evidencia?.id && !row) return textoGuia(getSession(db, user.id, chatId))
  try {
    const { title, summary, raw } = await proponerIdea(row ? [row] : [], opts)
    const ideaId = createIdea(db, {
      userId: user.id, title, summary,
      evidenceIds: row ? [row.id] : [],
    })
    if (raw) db.prepare('UPDATE ideas SET raw_llm_json = ? WHERE id = ?').run(JSON.stringify(raw), ideaId)
    setSession(db, user.id, chatId, 'proponiendo_idea', { ideaId })
    const folioLinea = evidencia?.folio ? `📥 ${evidencia.folio}\n\n` : ''
    return {
      texto: `${folioLinea}💡 *${title}*${summary ? `\n${summary}` : ''}\n\n¿Qué hacemos con esto?`,
      botones: BOTONES_IDEA,
      estado: 'proponiendo_idea',
    }
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    // la captura nunca se pierde: guardamos la idea en crudo aunque la IA no responda
    const fallbackTitle = (row?.text_content || row?.transcription || row?.vision_description || 'Evidencia sin título').slice(0, 80)
    if (row) createIdea(db, { userId: user.id, title: fallbackTitle, summary: null, evidenceIds: [row.id] })
    setSession(db, user.id, chatId, 'inicio', {})
    return {
      texto: `📥 Evidencia ${evidencia?.folio || ''} guardada. No pude generar la propuesta ahora (la IA no respondió), pero tu material quedó a salvo — probá de nuevo en un rato o mirá /cola.`,
      botones: [],
      estado: 'inicio',
    }
  }
}

// ---------------------------------------------------------------------------
// comando: /cola, /idea <texto>
// ---------------------------------------------------------------------------

async function handleComando(db, user, chatId, input) {
  const comando = input.comando || ''
  if (comando === '/cola') {
    const p = pendingFor(db, user.id)
    const lineas = []
    if (p.ideas.length) lineas.push(`💡 Ideas sin desarrollar: ${p.ideas.map((i) => i.title).join(', ')}`)
    if (p.drafts.length) lineas.push(`📝 Bocetos en refinamiento: ${p.drafts.map((d) => `${d.title} (${d.profile})`).join(', ')}`)
    if (p.programadas.length) lineas.push(`📅 Programadas: ${p.programadas.map((v) => `${v.channel} ${v.scheduled_at}`).join(', ')}`)
    const texto = lineas.length ? lineas.join('\n') : 'No tenés nada pendiente 🎉'
    return { texto, botones: [], estado: 'inicio' }
  }
  if (comando === '/idea' || comando.startsWith('/idea ')) {
    const titulo = comando.slice('/idea'.length).trim() || 'Idea sin título'
    const ideaId = createIdea(db, { userId: user.id, title: titulo, summary: null, evidenceIds: [] })
    setSession(db, user.id, chatId, 'proponiendo_idea', { ideaId })
    return {
      texto: `💡 *${titulo}*\n\n¿Qué hacemos con esto?`,
      botones: BOTONES_IDEA,
      estado: 'proponiendo_idea',
    }
  }
  if (comando === '/marca' || comando.startsWith('/marca ')) {
    return handleMarcaNueva(db, user, chatId, comando)
  }
  if (comando === '/invitar' || comando.startsWith('/invitar ')) {
    return handleInvitar(db, user, chatId, comando)
  }
  if (comando === '/conectar') {
    return handleConectar(db, user, chatId)
  }
  return textoGuia(getSession(db, user.id, chatId))
}

// /marca <nombre>: solo admin. Crea el perfil + owner + wa_status auto-conectado
// (mismo helper que usa la ruta REST — nunca duplicar el INSERT).
function handleMarcaNueva(db, user, chatId, comando) {
  if (!user.is_admin) {
    setSession(db, user.id, chatId, 'inicio', {})
    return { texto: '🔒 Solo el administrador puede crear marcas nuevas.', botones: [], estado: 'inicio' }
  }
  const nombre = comando.slice('/marca'.length).trim()
  if (!nombre) {
    return { texto: 'Decime el nombre de la marca, ej. /marca SkyTrace', botones: [], estado: 'inicio' }
  }
  crearPerfilConWaStatus(db, { name: nombre, slug: slugify(nombre), identity: {}, ownerId: user.id })
  setSession(db, user.id, chatId, 'inicio', {})
  return {
    texto: `✅ Marca "${nombre}" creada. WhatsApp Status ya está listo para paquetes manuales. Usá /conectar para sumar LinkedIn o Instagram.`,
    botones: [],
    estado: 'inicio',
  }
}

// perfiles donde el usuario tiene permiso para la acción dada (ej. 'invitar' → solo owner)
function perfilesConPermiso(db, userId, action) {
  return perfilesDe(db, userId).filter((p) => can(db, userId, p.id, action))
}

function generarCodigoInvitacion() {
  const bytes = crypto.randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) code += ALFABETO_CODIGO[bytes[i] % ALFABETO_CODIGO.length]
  return code
}

function generarInvitacion(db, user, chatId, profile, rol) {
  const code = generarCodigoInvitacion()
  db.prepare(`
    INSERT INTO invitations (code, profile_id, role, created_by, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+48 hours'))
  `).run(code, profile.id, rol, user.id)
  setSession(db, user.id, chatId, 'inicio', {})
  return {
    texto: `🎟️ Código para sumar a ${profile.name} como ${rol}: ${code}\n\nQue te escriban a este bot: /unirme ${code}\n(vence en 48 horas)`,
    botones: [],
    estado: 'inicio',
  }
}

// /invitar [rol]: solo owner del perfil. Genera un código de invitación de 8 chars,
// válido por 48h. Si el usuario es owner de varios perfiles, primero pregunta cuál.
function handleInvitar(db, user, chatId, comando) {
  const arg = comando.slice('/invitar'.length).trim()
  const rol = arg || 'editor'
  if (!ROLES_VALIDOS.includes(rol)) {
    return { texto: `Rol inválido. Elegí owner, editor o approver (ej. /invitar approver).`, botones: [], estado: 'inicio' }
  }
  const perfiles = perfilesConPermiso(db, user.id, 'invitar')
  if (perfiles.length === 0) {
    return { texto: '🔒 No sos owner de ninguna marca.', botones: [], estado: 'inicio' }
  }
  if (perfiles.length === 1) {
    return generarInvitacion(db, user, chatId, perfiles[0], rol)
  }
  setSession(db, user.id, chatId, 'eligiendo_perfil_invitacion', { comando: 'invitar', rol })
  const botones = perfiles.map((p) => ({ id: `perfil_${p.id}`, label: `👤 ${p.name}` }))
  return { texto: '¿Para qué marca es la invitación?', botones, estado: 'eligiendo_perfil_invitacion' }
}

// arranca (o retoma tras elegir perfil) el estado 'conectando_canal': primer paso,
// pedir qué canal conectar con botones.
function iniciarConexionCanal(db, user, chatId, profile) {
  setSession(db, user.id, chatId, 'conectando_canal', { profileId: profile.id, paso: 'canal', borrador: {} })
  return { texto: `¿Qué canal conectamos para ${profile.name}?`, botones: BOTONES_CANAL, estado: 'conectando_canal' }
}

// /conectar: solo owner. Resuelve el perfil igual que /invitar (único → directo,
// varios → botones perfil_<id>, ninguno → mensaje de bloqueo).
function handleConectar(db, user, chatId) {
  const perfiles = perfilesConPermiso(db, user.id, 'gestionar_canales')
  if (perfiles.length === 0) {
    return { texto: '🔒 No sos owner de ninguna marca.', botones: [], estado: 'inicio' }
  }
  if (perfiles.length === 1) {
    return iniciarConexionCanal(db, user, chatId, perfiles[0])
  }
  setSession(db, user.id, chatId, 'eligiendo_perfil_conexion', {})
  const botones = perfiles.map((p) => ({ id: `perfil_${p.id}`, label: `👤 ${p.name}` }))
  return { texto: '¿Para qué marca conectamos un canal?', botones, estado: 'eligiendo_perfil_conexion' }
}

// segundo turno de /conectar cuando el owner tiene varios perfiles: el botón perfil_<id>
// elegido arranca el estado conectando_canal para ese perfil.
function handlePerfilConexion(db, user, chatId, session, boton) {
  const pid = Number(boton.slice('perfil_'.length))
  const perfiles = perfilesConPermiso(db, user.id, 'gestionar_canales')
  const profile = perfiles.find((p) => p.id === pid)
  if (!profile) return textoGuia(session)
  return iniciarConexionCanal(db, user, chatId, profile)
}

// boton conectar_linkedin / conectar_instagram: fija el canal elegido y pide el
// primer campo de credencial (nunca todos juntos).
function handleCanalElegido(db, user, chatId, session, boton) {
  const channel = boton === 'conectar_linkedin' ? 'linkedin' : 'instagram'
  const profileId = session.data?.profileId
  const campos = CAMPOS_CANAL[channel]
  setSession(db, user.id, chatId, 'conectando_canal', { profileId, channel, paso: 'campo_0', borrador: {} })
  return { texto: CAMPO_PROMPT[channel][campos[0]], botones: [], estado: 'conectando_canal' }
}

// handleTexto en estado conectando_canal (una vez elegido el canal): guarda el campo
// actual y avanza. Al completar todos los campos, conecta el canal y confirma
// mostrando solo los últimos 4 caracteres del access_token — nunca el valor completo,
// ni acá ni en las confirmaciones intermedias.
function handleTextoConectar(db, user, chatId, session, input) {
  const { profileId, channel, paso, borrador = {} } = session.data
  const campos = CAMPOS_CANAL[channel]
  const idx = Number(paso.slice('campo_'.length))
  const campoActual = campos[idx]
  const nuevoBorrador = { ...borrador, [campoActual]: input.texto.trim() }

  if (idx + 1 < campos.length) {
    const siguienteCampo = campos[idx + 1]
    setSession(db, user.id, chatId, 'conectando_canal', { profileId, channel, paso: `campo_${idx + 1}`, borrador: nuevoBorrador })
    return { texto: `✅ Guardado. ${CAMPO_PROMPT[channel][siguienteCampo]}`, botones: [], estado: 'conectando_canal' }
  }

  conectarCanal(db, { profileId, channelCode: channel, credentials: nuevoBorrador })
  clearSession(db, user.id, chatId)
  const ultimos4 = (nuevoBorrador.access_token || '').slice(-4)
  return {
    texto: `✅ ${NOMBRE_CANAL[channel]} conectado (token terminado en ...${ultimos4}). Ya se puede publicar ahí.`,
    botones: [],
    estado: 'inicio',
  }
}

// ---------------------------------------------------------------------------
// texto: feedback en refinando_boceto
// ---------------------------------------------------------------------------

async function handleTexto(db, user, chatId, input, opts) {
  const session = getSession(db, user.id, chatId) || { state: 'inicio', data: {} }
  if (session.state === 'refinando_boceto' && session.data?.draftId) {
    const { ideaId, profileId, draftId, queue = [] } = session.data
    const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(profileId)
    if (!can(db, user.id, profileId, 'editar_boceto')) return sinPermisoEditar(profile)
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId)
    const { content, raw } = await refinarBoceto(profile, draft.content, input.texto, opts)
    updateDraft(db, draftId, { content, rawLlm: raw ? JSON.stringify(raw) : null })
    setSession(db, user.id, chatId, 'refinando_boceto', { ideaId, profileId, draftId, queue })
    return { texto: presentarBoceto(profile, content), botones: BOTONES_BOCETO, estado: 'refinando_boceto' }
  }
  if (session.state === 'conectando_canal' && session.data?.channel) {
    return handleTextoConectar(db, user, chatId, session, input)
  }
  if (session.state === 'inicio' || !session.state) return handleTextoCaptura(db, user, chatId, input, opts)
  return textoGuia(session)
}

// texto en 'inicio' (o sin sesión) = captura de evidencia, igual que clase 'evidencia'
async function handleTextoCaptura(db, user, chatId, input, opts) {
  let evidenceId
  try {
    const info = db.prepare(`
      INSERT INTO evidence (user_id, type, text_content, context_json) VALUES (?, 'texto', ?, ?)
    `).run(user.id, input.texto, '{"origen":"telegram"}')
    evidenceId = info.lastInsertRowid
  } catch (err) {
    console.error('captura texto falló:', err)
    return { texto: '⚠️ No pude guardar tu texto. Mandámelo de nuevo en un momento.', botones: [], estado: 'inicio' }
  }

  const result = await processEvidence(db, evidenceId, { fetchImpl: opts?.fetchImpl })
  const fila = db.prepare('SELECT transcription, vision_description FROM evidence WHERE id = ?').get(evidenceId)
  const entities = entitiesFor(db, evidenceId)
  const evidencia = {
    id: evidenceId,
    folio: `E-${String(evidenceId).padStart(4, '0')}`,
    processed: result.processed,
    detalle: {
      transcription: fila.transcription,
      vision_description: fila.vision_description,
      entities,
    },
  }
  return handleEvidencia(db, user, chatId, evidencia, opts)
}

// ---------------------------------------------------------------------------
// boton: idea_*, perfil_*, boceto_*, prog_*
// ---------------------------------------------------------------------------

async function handleBoton(db, user, chatId, input, opts) {
  const session = getSession(db, user.id, chatId) || { state: 'inicio', data: {} }
  const boton = input.boton || ''

  if (boton === 'idea_desarrollar') return handleIdeaDesarrollar(db, user, chatId, session, opts)
  if (boton === 'idea_guardar') return handleIdeaGuardar(db, user, chatId, session)
  if (boton === 'idea_descartar') return handleIdeaDescartar(db, user, chatId, session)
  if (boton.startsWith('perfil_') && session.state === 'eligiendo_perfil_invitacion') {
    return handlePerfilInvitacion(db, user, chatId, session, boton)
  }
  if (boton.startsWith('perfil_') && session.state === 'eligiendo_perfil_conexion') {
    return handlePerfilConexion(db, user, chatId, session, boton)
  }
  if (boton.startsWith('perfil_')) return handlePerfilElegido(db, user, chatId, session, boton, opts)
  if ((boton === 'conectar_linkedin' || boton === 'conectar_instagram') && session.state === 'conectando_canal') {
    return handleCanalElegido(db, user, chatId, session, boton)
  }
  if (boton === 'boceto_aprobar') return handleBocetoAprobar(db, user, chatId, session, opts)
  if (boton === 'boceto_otra') return handleBocetoOtra(db, user, chatId, session, opts)
  if (boton === 'boceto_descartar') return handleBocetoDescartar(db, user, chatId, session, opts)
  if (boton.startsWith('prog_')) return handleProgramar(db, user, chatId, session, boton, opts)
  return textoGuia(session)
}

function handleIdeaGuardar(db, user, chatId, session) {
  const ideaId = session.data?.ideaId
  if (ideaId) setIdeaStatus(db, ideaId, 'capturada')
  setSession(db, user.id, chatId, 'inicio', {})
  return { texto: '📥 Guardada en tu cola de ideas. Escribí /cola cuando quieras retomarla.', botones: [], estado: 'inicio' }
}

function handleIdeaDescartar(db, user, chatId, session) {
  const ideaId = session.data?.ideaId
  if (ideaId) setIdeaStatus(db, ideaId, 'descartada')
  setSession(db, user.id, chatId, 'inicio', {})
  return { texto: '🗑 Descartada. Cuando tengas otra novedad, mandámela.', botones: [], estado: 'inicio' }
}

async function handleIdeaDesarrollar(db, user, chatId, session, opts) {
  const ideaId = session.data?.ideaId
  const idea = ideaId ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId) : null
  if (!idea) return textoGuia(session)

  const perfiles = perfilesDe(db, user.id)
  if (perfiles.length === 0) {
    setSession(db, user.id, chatId, 'inicio', {})
    return { texto: 'Todavía no tenés perfiles de marca asignados — pedile a un admin que te invite.', botones: [], estado: 'inicio' }
  }
  if (perfiles.length === 1) {
    linkIdeaProfiles(db, idea.id, [perfiles[0].id])
    setIdeaStatus(db, idea.id, 'en_conversacion')
    return await redactarParaPerfil(db, user, chatId, idea, perfiles[0], [], opts)
  }
  setSession(db, user.id, chatId, 'eligiendo_perfiles', { ideaId: idea.id })
  const botones = [
    ...perfiles.map((p) => ({ id: `perfil_${p.id}`, label: `👤 ${p.name}` })),
    { id: 'perfil_ambas', label: '👥 Ambas' },
  ]
  return { texto: `¿Para qué perfil desarrollamos "${idea.title}"?`, botones, estado: 'eligiendo_perfiles' }
}

async function handlePerfilElegido(db, user, chatId, session, boton, opts) {
  const ideaId = session.data?.ideaId
  const idea = ideaId ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId) : null
  if (!idea) return textoGuia(session)

  const perfiles = perfilesDe(db, user.id)
  let elegidos
  if (boton === 'perfil_ambas') {
    elegidos = perfiles
  } else {
    const pid = Number(boton.slice('perfil_'.length))
    elegidos = perfiles.filter((p) => p.id === pid)
  }
  if (elegidos.length === 0) return textoGuia(session)

  linkIdeaProfiles(db, idea.id, elegidos.map((p) => p.id))
  setIdeaStatus(db, idea.id, 'en_conversacion')
  const [primero, ...resto] = elegidos
  return await redactarParaPerfil(db, user, chatId, idea, primero, resto.map((p) => p.id), opts)
}

// segundo turno de /invitar cuando el owner tiene varios perfiles: el botón perfil_<id>
// elegido completa la generación del código con el rol guardado en sesión.
function handlePerfilInvitacion(db, user, chatId, session, boton) {
  const rol = session.data?.rol || 'editor'
  const pid = Number(boton.slice('perfil_'.length))
  const perfiles = perfilesConPermiso(db, user.id, 'invitar')
  const profile = perfiles.find((p) => p.id === pid)
  if (!profile) return textoGuia(session)
  return generarInvitacion(db, user, chatId, profile, rol)
}

async function redactarParaPerfil(db, user, chatId, idea, profile, queueIds, opts) {
  if (!can(db, user.id, profile.id, 'editar_boceto')) {
    // sin permiso para este perfil: seguimos con el próximo en cola, si hay
    if (queueIds.length > 0) {
      const [nextId, ...resto] = queueIds
      const nextProfile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(nextId)
      return await redactarParaPerfil(db, user, chatId, idea, nextProfile, resto, opts)
    }
    setSession(db, user.id, chatId, 'inicio', {})
    return { texto: `🔒 No tenés permiso para editar bocetos en ${profile.name}.`, botones: [], estado: 'inicio' }
  }
  const evidencias = evidenciasDeIdea(db, idea.id)
  const { content, raw } = await redactarBoceto(profile, idea, evidencias, opts)
  const draftId = createDraft(db, { ideaId: idea.id, profileId: profile.id, content, rawLlm: raw ? JSON.stringify(raw) : null })
  setSession(db, user.id, chatId, 'refinando_boceto', { ideaId: idea.id, profileId: profile.id, draftId, queue: queueIds })
  return { texto: presentarBoceto(profile, content), botones: BOTONES_BOCETO, estado: 'refinando_boceto' }
}

async function handleBocetoAprobar(db, user, chatId, session, opts) {
  const { ideaId, profileId, draftId, queue = [] } = session.data || {}
  if (!draftId) return textoGuia(session)
  const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(profileId)
  if (!can(db, user.id, profileId, 'aprobar')) {
    return { texto: `🔒 Necesitás rol approver para aprobar en ${profile.name}.`, botones: BOTONES_BOCETO, estado: 'refinando_boceto' }
  }
  setDraftStatus(db, draftId, 'aprobado')
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId)
  return await avanzarCola(db, user, chatId, idea, queue, opts)
}

async function handleBocetoDescartar(db, user, chatId, session, opts) {
  const { ideaId, profileId, draftId, queue = [] } = session.data || {}
  if (!draftId) return textoGuia(session)
  const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(profileId)
  if (!can(db, user.id, profileId, 'editar_boceto')) return sinPermisoEditar(profile)
  setDraftStatus(db, draftId, 'descartado')
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId)
  return await avanzarCola(db, user, chatId, idea, queue, opts)
}

async function handleBocetoOtra(db, user, chatId, session, opts) {
  const { ideaId, profileId, draftId, queue = [] } = session.data || {}
  if (!draftId) return textoGuia(session)
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId)
  const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(profileId)
  if (!can(db, user.id, profileId, 'editar_boceto')) return sinPermisoEditar(profile)
  const evidencias = evidenciasDeIdea(db, idea.id)
  const { content, raw } = await redactarBoceto(profile, idea, evidencias, opts)
  updateDraft(db, draftId, { content, rawLlm: raw ? JSON.stringify(raw) : null })
  setSession(db, user.id, chatId, 'refinando_boceto', { ideaId: idea.id, profileId: profile.id, draftId, queue })
  return { texto: presentarBoceto(profile, content), botones: BOTONES_BOCETO, estado: 'refinando_boceto' }
}

// tras aprobar/descartar un boceto: sigue con el próximo perfil en cola, o pasa
// a programar (si hay algo aprobado) o vuelve a inicio (si no quedó nada).
async function avanzarCola(db, user, chatId, idea, queue, opts) {
  if (queue.length > 0) {
    const [nextId, ...resto] = queue
    const nextProfile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(nextId)
    return await redactarParaPerfil(db, user, chatId, idea, nextProfile, resto, opts)
  }
  const { n: aprobados } = db.prepare("SELECT COUNT(*) n FROM drafts WHERE idea_id = ? AND status = 'aprobado'").get(idea.id)
  if (aprobados > 0) {
    setSession(db, user.id, chatId, 'programando', { ideaId: idea.id })
    return { texto: '¿Cuándo lo publicamos?', botones: BOTONES_PROG, estado: 'programando' }
  }
  setSession(db, user.id, chatId, 'inicio', {})
  return { texto: 'Listo, no quedó nada pendiente de programar.', botones: [], estado: 'inicio' }
}

// ---------------------------------------------------------------------------
// prog_*: crea channel_versions por cada canal conectado de cada draft aprobado
// ---------------------------------------------------------------------------

async function handleProgramar(db, user, chatId, session, boton, opts) {
  const ideaId = session.data?.ideaId
  const idea = ideaId ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId) : null
  if (!idea) return textoGuia(session)

  const aprobados = db.prepare("SELECT * FROM drafts WHERE idea_id = ? AND status = 'aprobado'").all(idea.id)

  // matriz de permisos: solo se programan los drafts cuyo perfil autoriza 'programar'
  const drafts = []
  const sinPermisoPerfiles = []
  for (const draft of aprobados) {
    if (can(db, user.id, draft.profile_id, 'programar')) {
      drafts.push(draft)
    } else {
      const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(draft.profile_id)
      sinPermisoPerfiles.push(profile.name)
    }
  }

  if (drafts.length === 0 && sinPermisoPerfiles.length > 0) {
    // nadie de los perfiles aprobados puede ser programado por este usuario: estado se mantiene
    return {
      texto: `🔒 Necesitás rol approver para programar en: ${sinPermisoPerfiles.join(', ')}.`,
      botones: BOTONES_PROG,
      estado: 'programando',
    }
  }

  const foto = fotoDeIdea(db, idea.id)
  const resumen = []

  for (const draft of drafts) {
    const profile = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(draft.profile_id)
    const canales = connectedChannels(db, profile.id)
    for (const canal of canales) {
      const formatCode = foto ? FORMATO_CON_IMAGEN[canal.code] : FORMATO_SOLO_TEXTO[canal.code]
      if (!formatCode) continue // sin formato viable para este canal en este escenario

      // idempotencia: si ya existe una versión para este draft+canal (reintento tras
      // una falla a mitad de camino), la reusamos en vez de duplicarla.
      const existente = db.prepare(
        'SELECT id FROM channel_versions WHERE draft_id = ? AND profile_channel_id = ?'
      ).get(draft.id, canal.id)
      if (existente) {
        resumen.push(`• ${profile.name} → ${canal.code}/${formatCode} (ya estaba programado)`)
        continue
      }

      const adapt = await adaptarVersion(profile, draft.content, canal.code, formatCode, opts)

      let mediaPath = null
      if (foto) {
        const dims = FORMAT_DIMENSIONS[`${canal.code}:${formatCode}`]
        if (dims) {
          const dir = path.join(process.env.MEDIA_DIR || '/data/media', 'versions')
          mkdirSync(dir, { recursive: true })
          const outPath = path.join(dir, `v${draft.id}_${canal.code}_${formatCode}.jpg`)
          await renderChannelImage(foto.file_path, outPath, { ...dims, label: profile.name })
          mediaPath = outPath
        }
      }

      let status = 'aprobada'
      let scheduledAt = null
      if (boton === 'prog_ahora') { status = 'programada'; scheduledAt = nowSql(db) }
      else if (boton === 'prog_maniana') { status = 'programada'; scheduledAt = tomorrowNineSql(db) }

      createChannelVersion(db, {
        draftId: draft.id, profileChannelId: canal.id, formatCode,
        textContent: adapt.text, mediaPath, hashtags: adapt.hashtags, status, scheduledAt,
      })
      resumen.push(`• ${profile.name} → ${canal.code}/${formatCode}${scheduledAt ? ` (📅 ${scheduledAt})` : ' (⏳ a la cola)'}`)
    }
  }

  setIdeaStatus(db, idea.id, 'lista')
  setSession(db, user.id, chatId, 'inicio', {})
  const notaSinPermiso = sinPermisoPerfiles.length ? `\n\n🔒 Sin permiso para programar en: ${sinPermisoPerfiles.join(', ')}.` : ''
  const texto = resumen.length
    ? `Listo, quedó así:\n${resumen.join('\n')}${notaSinPermiso}`
    : 'No había canales conectados para publicar esto todavía.'
  return { texto, botones: [], estado: 'inicio' }
}
