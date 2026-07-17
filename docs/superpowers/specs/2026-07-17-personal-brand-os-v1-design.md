# Personal Brand OS — Diseño v1

**Fecha:** 2026-07-17
**Estado:** aprobado en sesión de brainstorming (Juan Pablo Sarobe + Claude)
**Reemplaza a:** documento de visión v0.2 (lo incorpora y lo aterriza)

---

## 1. Qué estamos construyendo

Un **motor configurable de marca personal**: captura evidencia de avances personales y
laborales (fotos, audios, videos, textos, links) por Telegram, la convierte
conversacionalmente en contenido profesional por marca, y lo publica —automática o
asistidamente— en redes sociales.

**No es un generador de publicaciones**: es un sistema operativo para gestionar
reputación profesional a largo plazo (principio rector de la visión v0.2).

### Decisiones de alcance (v1)

| Decisión | Valor |
| --- | --- |
| Primer resultado buscado | Contenido de Juan Pablo publicándose con constancia |
| Canal de entrada | Telegram (bot propio). WhatsApp descartado por costos de API Meta; queda como canal futuro |
| Canales de salida v1 | LinkedIn (automático) + Instagram (automático; Facebook de regalo vía crossposting nativo de IG) + WhatsApp Status (asistido manual) |
| Perfiles | Juan Pablo primero; SkyTrace apenas el flujo ande; FullControl después. **Sumar una marca = configurar un perfil, cero código** |
| Multiusuario | Estructura de usuarios/roles/permisos desde el día 1 (imposible de retrofitear); una sola persona real en v1 |
| Infraestructura | Mac mini propia, Docker Compose, costo $0 |
| IA | Free tiers (Groq columna vertebral), proveedores/modelos como configuración con fallback |
| Comercialización | Primero configuración manual por cliente (modelo agencia); SaaS autogestionado solo si el negocio lo valida |

### Principio operativo de publicación

*Lo fácil de automatizar se automatiza; lo demás, el bot entrega el paquete terminado
(texto + imagen/video procesados) listo para copiar/pegar, preferentemente con link
directo.* Y siempre: **mínima fricción para capturar, máximo control para publicar** —
nada sale a un canal sin aprobación explícita.

---

## 2. Arquitectura

```
┌─────────────┐
│ Usuario     │  foto / audio / texto / link
│ (Telegram)  │◄──── bocetos, botones de aprobación
└──────┬──────┘
       │ long polling (la Mac mini no expone puertos)
       ▼
┌── puente-telegram (contenedor liviano) ──┐
│  grammY en polling → POST al webhook     │
│  local de n8n · sin túnel               │
└──────────────┬───────────────────────────┘
               ▼
┌── n8n (contenedor) ──────────────────────┐
│  ORQUESTA, no piensa ni persiste:        │
│  contexto → usuario → sesión → router    │
└──────────────┬───────────────────────────┘
               │ REST
               ▼
┌── core-api (contenedor) ─────────────────┐
│  DUEÑA de los datos y del cerebro:       │
│  · SQLite + media en volumen /data       │
│  · Usuarios, roles y permisos            │
│  · Perfiles de Marca (N marcas)          │
│  · Capa de IA (router por tarea)         │
│  · Agente creativo (POST /agent/next-turn)│
│  · Publicadores enchufables por canal    │
│  · Scheduler de publicaciones (cron)     │
└──────────────────────────────────────────┘
       + Tailscale en el host (callback OAuth y acceso remoto seguro)
```

Enfoque elegido: **1 de 3** ("HSE evolucionado" — reutiliza la arquitectura validada en
el proyecto `incident-free_systemic_learning`), **con la puerta abierta al Enfoque 3**
(agente conversacional especializado): la conversación creativa vive detrás de
`core-api /agent/next-turn`; n8n solo mueve mensajes. Cambiar el motor del agente no
toca ningún nodo.

Decisiones clave:

1. **n8n orquesta; core-api es dueña de datos Y de la conversación creativa** (a
   diferencia del HSE, los prompts se ejecutan desde core-api).
2. **Puente de long polling** en vez de túnel: sin cloudflared, sin URLs rotativas, sin
   exposición de red. (Un túnel volverá solo si un canal futuro exige webhooks entrantes.)
3. **Todo multi-perfil y multi-usuario desde la primera tabla.** Nada hardcodeado a una
   persona.
4. **Publicadores con contrato común** (ver §7). Catálogo de canales abierto.
5. **Mismo esqueleto operativo del HSE**: docker-compose, nodos n8n como funciones puras
   en `src/`, prompts en archivos versionados, workflow generado por build.

---

## 3. Capa de IA (router configurable por tarea)

**Principio: los modelos son configuración, nunca código** — los catálogos free rotan
(Kimi K2 entró y salió del free tier de Groq). Tabla `task → proveedor/modelo/fallback`
en configuración; cada Perfil de Marca puede sobreescribirla por tarea. Todos los
proveedores de texto detrás de interfaz compatible OpenAI.

| Tarea | v1 (gratis) | Fallback configurable |
| --- | --- | --- |
| Transcribir audio | Whisper @ Groq | — |
| Entender fotos/videos | Llama 4 Scout @ Groq | Gemini free |
| Conversación y redacción | Llama 3.3 70B / Qwen3 / gpt-oss @ Groq | DeepSeek API (muy barata), OpenAI, etc. |
| Procesar imagen (marca) | **Sharp + plantillas por perfil — sin IA** | — |
| Generar imagen (opcional) | Nano Banana (Gemini, cuota free inestable) | Flux/SD local en Mac mini |
| Video | — (v2: ffmpeg determinístico; v3: generativa) | — |

Insight rector: **separar procesar de generar**. El 90% de v1 es procesamiento
determinístico de evidencia real (recorte por formato, marco/plantilla de marca, logo,
tarjeta de texto) → Sharp/ImageMagick: gratis, instantáneo, visualmente consistente
(identidad > variedad). La generación con IA es opcional y nunca dependencia crítica.

Notas de contexto: las suscripciones personales (Claude Max, ChatGPT Plus, Copilot) no
incluyen API para backends — el motor usa APIs propias. Límites free de Groq (~30 RPM /
~1.000 req/día por modelo) sobran para este volumen. El JSON crudo de cada llamada LLM
se audita en la fila que generó (`raw_llm_json`, patrón HSE).

---

## 4. Modelo de datos

Columna vertebral:

```
evidencia ──► idea ──► boceto ──► versión de canal
(materia     (qué      (por        (por canal y formato:
 prima)      contar)   perfil)     texto+media adaptados)
```

Tablas:

1. **`users`** — quién puede hablarle al bot: chat ID de Telegram, nombre, estado
   (`activo`/`invitado`/`suspendido`). Alta por invitación con código de un solo uso
   (`/invitar` → código con vencimiento 48 h). Remitentes fuera de `users`: silencio
   administrativo.
2. **`user_profile_access`** — matriz usuario × perfil × rol:
   - `owner`: todo (identidad, credenciales, invitar al perfil)
   - `editor`: captura, ideas, bocetos — **no** aprueba publicación
   - `approver`: editor + aprobar y programar
   **Regla transversal: ninguna query existe sin contexto de usuario.** Cada sesión nace
   con la identidad del remitente y solo ve sus perfiles/su cola/su evidencia.
   Escenario habilitado sin código futuro: community manager (`editor`) redacta, el
   dueño (`approver`) aprueba y sale en la cuenta del perfil (credenciales del perfil,
   no del redactor).
3. **`brand_profiles`** — el corazón configurable. Identidad, objetivos, público, tono,
   temáticas, palabras frecuentes, cosas que nunca comunicar, nivel técnico, estilo
   visual (campos de la visión v0.2) + plantilla visual (Sharp), cadencia deseada,
   estrategia de formatos, overrides de modelo IA por tarea.
4. **`channels`** — catálogo abierto: código, estado (`activo`/`reservado`/`planificado`),
   módulo publicador. Todo el máster plan vive acá como filas.
5. **`channel_formats`** — hija de channels: formatos por canal (LinkedIn: texto,
   imagen, video, documento-carrusel; IG: feed, carrusel, historia, reel-v2) con
   capacidades (dimensiones, límites, ¿automatizable?).
6. **`profile_channels`** — perfil × canal: handle, credenciales/tokens **cifrados en
   reposo**, estado. Las cuentas de cada marca son filas, nunca `.env`.
7. **`evidence`** — todo lo capturado: tipo, ruta en volumen `/data`, transcripción,
   descripción de visión, fecha, contexto, usuario que capturó. **Nunca se borra ni se
   consume**: archivo histórico profesional e insumo del grafo futuro.
8. **`ideas`** — unidad editorial. Nace de 1..N evidencias (N a N) o de cero. Estado:
   `capturada → en_conversación → lista → descartada`. Apunta a 1..N perfiles.
9. **`drafts`** — boceto = idea × perfil: mismo hecho, voz de cada marca; conversación
   de refinamiento y aprobación propias.
10. **`channel_versions`** — hoja final = boceto × canal × **formato**: texto adaptado,
    media procesada, hashtags, etiquetas propuestas/incluidas, ciclo de vida
    `pendiente → aprobada → programada → publicada (url)` o `entregada_manual` (con
    botón "ya lo publiqué" para cerrar ciclo). Calendario = `scheduled_at` + cadencia
    del perfil.
11. **`sessions`** — estado conversacional efímero con TTL, keyed por usuario+chat. La
    conversación no se archiva; el resultado sí.
12. **`entities` + `entity_mentions`** — embrión del grafo de conocimiento: personas,
    empresas, tecnologías, proyectos, lugares; extracción automática por LLM al
    procesar evidencia/ideas. Cada entidad guarda **handles sociales por canal** (para
    etiquetar) y opcionalmente ubicación GPS (matcheo por cercanía, v1.5). Primera
    aparición → el bot pregunta una vez por sus @; luego propone etiquetas solo.
13. **`publish_log`** — cada intento de publicación: timestamp, canal, respuesta cruda
    de la API (auditoría de publicadores).

Transversales: media en volumen, rutas en DB; SQLite WAL (→ Postgres solo si SaaS);
secretos de marca cifrados (libsodium), clave maestra en `.env`.

### Etiquetado social (alcance honesto)

- Dicho/escrito en la evidencia → detección automática confiable (caso 95%).
- Solo foto sin contexto → visión describe la escena, no identifica el lugar específico;
  con EXIF GPS (foto como archivo) se habilita matcheo por cercanía (v1.5).
- API: menciones @ en caption de IG funcionan; organizaciones en LinkedIn con soporte;
  personas en LinkedIn restringido por la plataforma → aplica regla general: paquete con
  nota "agregá la etiqueta a mano".

---

## 5. Flujos conversacionales

Máquina de estados por sesión (TTL):
`capturando → proponiendo_idea → eligiendo_perfiles → refinando_boceto (por boceto) → programando`.
n8n rutea por estado + tipo de mensaje; la inteligencia de cada turno la resuelve
`core-api /agent/next-turn`.

**Flujo principal:** evidencia (ej. foto + audio) → bot confirma con transcripción y
guarda (#E-xxxx) → propone idea `[Desarrollar] [Solo guardar] [Descartar]` → elección de
perfil(es) `[Juan Pablo] [SkyTrace] [Ambas]` → boceto por perfil con: texto con la voz
del perfil, imagen procesada con su plantilla, hashtags, etiquetas propuestas, y
**propuesta de formato razonada** ("lo veo como carrusel en LinkedIn + feed en IG") →
`[Aprobar] [Charlar cambios] [Otra versión] [Descartar]` → programación
`[Ahora] [Mañana 9hs] [Elegir] [A la cola]`. Canales manuales reciben el paquete listo.

**Flujos secundarios:**

- **Captura muda** ("guardá"): evidencia al archivo sin desarrollar — elimina la culpa
  de capturar sin publicar.
- **`/cola`**: pendientes (ideas sin desarrollar, bocetos sin aprobar, programadas) +
  cancelar/editar hasta el momento de publicar.
- **`/idea`**: idea de cero sin evidencia.
- **`/marca nueva`**: onboarding de perfil por conversación (ver §7).
- **`/invitar`**: alta de usuarios con rol por perfil.
- **Iniciativa del bot con permiso**: si la cadencia del perfil se atrasa, sugiere una
  vez, sin insistir; configurable/apagable por perfil.

**Reglas de oro (heredadas del HSE):** nunca silencio (ACK inmediato + respuesta real
asíncrona); todo camino termina en un mensaje; si la IA falla, la captura **nunca** se
pierde ("guardé tu evidencia, retomamos luego"); selección de formato propuesta por el
motor pero decidida por el usuario.

---

## 6. Elección de formato

El formato es un atributo de la versión de canal. Tres niveles:

1. **Catálogo** (`channel_formats`): qué existe y qué es automatizable.
2. **Propuesta del motor** por naturaleza del material: foto potente + texto corto → IG
   feed (+ eco historia); reflexión larga → LinkedIn texto; "N aprendizajes" → LinkedIn
   documento-carrusel (altísimo alcance orgánico); video vertical → reel (v2).
3. **Estrategia del perfil**: preferencias de formato por marca (configuración).

Bonus activable por perfil: **eco-historia** — al publicar en feed IG, la misma imagen
sale como historia (v1.5).

---

## 7. Publicadores, credenciales y errores

**Contrato:** `publicar(versión) → {url} | {paquete_manual} | {error_reintentable}`.
Scheduler (cron en core-api) despacha versiones `programadas` vencidas. Solo
`aprobada`/`programada` son publicables (garantía dura de aprobación).

**Publicadores v1:**

1. **LinkedIn** — OAuth perfil propio ("Share on LinkedIn" + OpenID, gratis). Texto,
   imágenes, video, documento-carrusel. Tokens vencen ~60 días → job diario de salud de
   tokens + aviso proactivo con link de renovación (30 s desde el celular).
2. **Instagram** — Graph API, cuenta Professional + página FB + app Meta. Dos pasos
   (contenedor → publicar). Feed/carrusel/historia (reel v2). Límite 25/día (holgado).
   Modo desarrollo funciona con cuentas propias; revisión de Meta (2–4 semanas) se
   tramita en paralelo sin bloquear.
3. **Paquete manual** (WA Status y fallback universal) — imagen final + texto listo +
   instrucción mínima por Telegram; estado `entregada_manual` + botón de cierre.

**Errores — regla madre: un contenido aprobado jamás se pierde.** Reintentos con backoff
(1, 5, 15 min) → degrada a paquete manual + aviso. `publish_log` audita todo intento.
**Validación temprana** de specs por formato al generar (no al publicar). Idempotencia
por versión (no hay doble publicación tras éxito silencioso).

**Credenciales — dos niveles:**

- **De marca (crecen):** en DB cifradas (`profile_channels`). Alta y renovación 100%
  conversacionales (`/marca nueva` → botones → link OAuth → token guardado). **Agregar
  FullControl no toca archivos ni reinicia servicios.**
- **Del motor (inmutables):** `.env` mínimo — clave maestra, token del bot, API key
  Groq, app-id/secret de Meta y LinkedIn (compartidas por todas las marcas).

**Callback OAuth sin exponer la red: Tailscale** (gratis) — la URL de callback es
alcanzable solo desde los dispositivos propios, desde cualquier lugar. Decisión
explícita: **no** usar secrets manager externo en esta escala (burocracia sin retorno);
reevaluar solo si SaaS.

En git no vive ningún secreto, nunca — solo `.env.example`.

---

## 8. Verificación

1. **Lógica sin n8n**: nodos Code como funciones puras con arnés (`$input/$env`
  simulados). Casos: flujo completo, multi-perfil, usuario sin permiso, LLM caído,
  corrección post-boceto. Prompts testeados con casos reales (`raw_llm_json` alimenta la
  batería).
2. **Core-api sola**: seed + `curl`, incluida la matriz de permisos (el usuario B no ve
  el perfil de A: test automatizado).
3. **Publicadores en seco**: `dry_run` global — loguean sin llamar APIs; circuito
  completo probado sin publicar.
4. **End-to-end real**: foto+audio por Telegram → boceto <1 min → aprobar → URL
  publicada → histórico en `/cola`. Primer post real: "probando mi nuevo sistema 🤖".

---

## 9. Despliegue

- `docker-compose` en Mac mini: `puente-telegram`, `n8n`, `core-api` + Tailscale en host.
- Volumen `/data` (SQLite + media) con **backup diario automático cifrado** a segundo
  disco o remoto — la evidencia histórica es lo único irreemplazable.
- Repo: `docker-compose.yml`, `core-api/`, `n8n/src|prompts|build`, `docs/`,
  `.env.example`.

**Setup humano (una vez, semana 1):** IG → Professional; app Meta; app LinkedIn; bot en
@BotFather; Tailscale. Documentado paso a paso estilo README del HSE.

---

## 10. Roadmap / Máster plan

Principio: **audiencia propia vs. alquilada** — las redes son distribución; el archivo
canónico es propio (la base ya lo tiene todo estructurado).

| Etapa | Contenido |
| --- | --- |
| **v1** | Todo lo especificado en este documento |
| **v1.5** | Canal de Telegram propio (casi gratis: el bot ya vive ahí); eco-historias; notificaciones de aprobación cruzada; matcheo GPS de entidades |
| **v2** | Sitio propio autogenerado desde la base (GitHub/Cloudflare Pages, $0: archivo canónico + SEO); X + Threads + Bluesky (texto corto, APIs fáciles); video determinístico (ffmpeg + subtítulos Whisper) → Reels + TikTok + YouTube Shorts (un asset, tres canales); SkyTrace y FullControl plenos |
| **v3** | YouTube largo (auditoría de API de Google mediante; contenido que se revaloriza); newsletter (LinkedIn Newsletter → email propio); generación de imagen/video con IA si un caso lo paga (Veo/Sora/Kling: caras); observador de tendencias; grafo de conocimiento explotando `entities` |
| **Analizar si aplica** | WhatsApp Channels (sin API oficial); Medium/Dev.to (republicación canónica); Google Business Profile (SkyTrace) |
| **SaaS (si el negocio valida)** | `workspaces` sobre la matriz usuario→rol→perfil existente; facturación; Postgres; secrets manager; onboarding autogestionado. Antes: modelo agencia con configuración manual por cliente |
| **Semana 1, sin código** | **Reservar handles en todos los canales del plan** para las tres marcas (Juan Pablo, SkyTrace, FullControl); altas de apps y cuentas del §9 |

Decisiones YAGNI explícitas: sin workspaces hoy; sin secrets manager hoy; sin
generación de video hoy; WhatsApp como canal de entrada descartado mientras Meta cobre
por conversación.

---

## 11. Referencias

- Visión v0.2 (documento fundacional, incorporado acá).
- Proyecto de referencia: `juanpablosarobe/incident-free_systemic_learning` (arquitectura
  n8n + core-api + SQLite validada; patrones: nunca silencio, confirmación antes de
  persistir, prompts versionados, workflow generado por build, `raw_llm_json`).
- Perfil LinkedIn base del primer Perfil de Marca:
  https://www.linkedin.com/in/juanpablosarobe
