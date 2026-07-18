# Plan E — Onboarding conversacional (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar el círculo de "sumar una marca es configurar un perfil, cero código" (spec, principio rector): crear perfiles y conectar canales por conversación, invitar a otras personas (community manager, socio) con roles, y dejar el sistema operable en la Mac mini con backups automáticos y una guía de setup completa. Con esto el v1 completo del spec queda entregado.

**Architecture:** Todo dentro de `next-turn.js` como nuevos comandos y un nuevo estado de sesión `conectando_canal`, más UNA ruta nueva sin autenticar (`POST /api/invitations/redeem`) para resolver el problema del huevo-y-la-gallina: alguien nuevo no puede pasar por `authMiddleware` porque todavía no existe en `users`. n8n gana una rama mínima para ese único caso. El resto (crear perfil, invitar, conectar canal) usa la conversación ya autenticada de siempre.

**Plan series:** A ✅ B1 ✅ B2 ✅ C1 ✅ C2 ✅ D ✅ · **E (este, último)**.

## Global Constraints

- `/marca nueva <nombre>`: solo admin (`user.is_admin`, mismo gate que `POST /api/profiles`). Crea `brand_profiles` + `user_profile_access` (owner, el creador) + auto-conecta `wa_status` (`profile_channels` status `conectado`, sin credenciales — `manual.js` no las necesita). Reutiliza la misma lógica desde la ruta REST y desde next-turn vía un helper compartido en `editorial.js` (nunca duplicar el INSERT).
- `/invitar <rol>`: solo `owner` del perfil activo en sesión (o si el usuario tiene un solo perfil, se usa ese; si tiene varios, primero pregunta cuál con botones `perfil_<id>`). Rol válido: `owner|editor|approver` (default `editor` si no se especifica). Genera código de 8 chars alfanumérico mayúsculas, tabla `invitations` existente, `expires_at` = +48h. Responde con el código y la instrucción `/unirme <código>`.
- `/unirme <código>`: comando especial que **no pasa por auth de core-api** — lo intercepta n8n ANTES del paso de autenticación normal y llama a la nueva ruta pública `POST /api/invitations/redeem`. Válido código: no usado, no vencido → da de alta al usuario (si el chat_id no existe en `users`, lo crea `activo`; si existe pero `suspendido`, rechaza) + `user_profile_access` con el rol de la invitación + marca la invitación usada. Inválido/vencido/usado → mensaje claro sin filtrar detalles del perfil ajeno.
- `/conectar`: solo `owner`. Flujo guiado con botones (`conectar_linkedin`, `conectar_instagram`) y luego mensajes de texto secuenciales para cada credencial (nunca pedir todo junto). Al completar: `encryptJson` + upsert en `profile_channels` (reutiliza el mismo camino que `POST /api/profiles/:id/channels`, vía un helper compartido, no la ruta HTTP en sí). Nuevo estado de sesión `conectando_canal` con `data: {profileId, channel, paso, borrador}`.
- Nunca loguear ni ecoar credenciales completas en la respuesta del bot (confirmar con los últimos 4 caracteres nomás, ej. `...aB3x`).
- Backup: script de shell fuera de core-api (no Node, no vitest — es infraestructura operada por cron en la Mac mini), documentado y con instrucciones de restore.
- Español. TDD para todo el código Node (rutas, next-turn, mapper). Branch `claude/nuevo-proyecto-dxakbn`. Git identity ya configurada (firma SSH activa) — commitear normal.

## File Structure

```
core-api/src/services/editorial.js       # (modif) crearPerfilConWaStatus, conectarCanal helpers
core-api/src/routes/profiles.js          # (modif) usa los helpers compartidos
core-api/src/routes/invitations.js       # (nuevo) POST /redeem, sin auth
core-api/src/app.js                      # (modif) monta invitations ANTES del middleware de auth
core-api/src/agent/next-turn.js          # (modif) /marca nueva, /invitar, /conectar + estado conectando_canal
puente-telegram/src/mapper.js            # (modif) captura from.first_name para el alta de invitados
n8n/src/01-preparar-turno.js             # (modif) detecta /unirme → camino 'unirme'
n8n/src/04-armar-unirme.js               # (nuevo) arma la llamada a /redeem y su respuesta
n8n/build-workflow.mjs                   # (modif) rama unirme en el workflow
scripts/backup.sh                        # (nuevo) backup diario cifrado
core-api/tests/*.test.js                 # nuevos/modificados por task
README.md / .env.example                 # (modif) guía completa de setup + OAuth/Tailscale
```

---

### Task 1: Crear perfil por conversación + auto-conexión de WhatsApp Status

**Files:**
- Modify: `core-api/src/services/editorial.js`, `core-api/src/routes/profiles.js`, `core-api/src/agent/next-turn.js`
- Test: `core-api/tests/editorial.test.js` (ampliar), `core-api/tests/next-turn-marca.test.js` (nuevo)

**Interfaces:**
- `editorial.js` gana: `crearPerfilConWaStatus(db, {name, slug, identity, ownerId}) → profileId` — INSERT `brand_profiles` + `user_profile_access` (owner) + INSERT `profile_channels` para el canal `wa_status` con `status='conectado'`, `credentials_enc=null` (busca el `channel_id` por `code='wa_status'` del seed).
- `routes/profiles.js` `POST /`: reemplaza sus 3 INSERTs manuales por una llamada a `crearPerfilConWaStatus` (mismo comportamiento observable, mismos tests existentes deben seguir pasando).
- `next-turn.js`: comando `/marca <nombre>` (ej. `/marca SkyTrace`) — si `!user.is_admin` → texto '🔒 Solo el administrador puede crear marcas nuevas.', botones [], estado inicio. Si admin: `crearPerfilConWaStatus`, responde `✅ Marca "{nombre}" creada. WhatsApp Status ya está listo para paquetes manuales. Usá /conectar para sumar LinkedIn o Instagram.`, estado `inicio`.

- [ ] **Step 1: Test que falla** — extender `editorial.test.js` con un test de `crearPerfilConWaStatus` (perfil creado, owner correcto, `profile_channels` tiene una fila `wa_status`/`conectado`); crear `next-turn-marca.test.js` con 2 tests (admin crea marca → verifica DB + texto de confirmación; no-admin → 🔒 y nada creado).
- [ ] **Step 2: RED**
- [ ] **Step 3: Implementar** el helper, refactorizar la ruta para usarlo, agregar el comando en `handleComando`.
- [ ] **Step 4: Suite completa** — PASS (sin regresión en `profiles.test.js`).
- [ ] **Step 5: Commit** — `git add core-api/src/services/editorial.js core-api/src/routes/profiles.js core-api/src/agent/next-turn.js core-api/tests/editorial.test.js core-api/tests/next-turn-marca.test.js && git commit -m "feat(core-api): crear marca por conversacion con wa_status auto-conectado"`

---

### Task 2: `/invitar` genera código

**Files:**
- Modify: `core-api/src/agent/next-turn.js`
- Test: `core-api/tests/next-turn-invitar.test.js`

**Interfaces:**
- Comando `/invitar` o `/invitar <rol>` (`owner|editor|approver`, default `editor`, rol inválido → aviso y no genera nada). Requiere `can(db, user.id, profileId, 'invitar')` (ya mapea a rol `owner` en `permissions.js`). Resolución del perfil: si el usuario es owner de exactamente 1 perfil, ese; si de varios, responde con botones `perfil_<id>` y guarda `{comando:'invitar', rol}` en sesión estado `eligiendo_perfil_invitacion` (nuevo, mínimo: solo espera un botón `perfil_<id>` y repite la lógica de generación); si de ninguno, '🔒 No sos owner de ninguna marca.'.
- Código: 8 chars `[A-Z0-9]` sin ambigüos (sin `0/O/1/I`), `crypto.randomBytes` + mapeo a alfabeto seguro. INSERT `invitations` (`code, profile_id, role, created_by, expires_at` = +48h). Respuesta: `🎟️ Código para sumar a {marca} como {rol}: {CODE}\n\nQue te escriban a este bot: /unirme {CODE}\n(vence en 48 horas)`.

- [ ] **Step 1-2: Test + RED** — casos: owner con 1 perfil genera código válido en DB con expiración correcta; rol explícito respetado; rol inválido rechazado sin insertar; no-owner rechazado; owner de 2 perfiles recibe botones y el segundo turno (botón `perfil_<id>`) completa la generación.
- [ ] **Step 3: Implementar** en `handleComando` + una rama nueva en `handleBoton` para `eligiendo_perfil_invitacion`.
- [ ] **Step 4: Suite completa** — PASS.
- [ ] **Step 5: Commit** — `git add core-api/src/agent/next-turn.js core-api/tests/next-turn-invitar.test.js && git commit -m "feat(core-api): generar codigos de invitacion por conversacion"`

---

### Task 3: Captura del nombre del remitente en el puente

**Files:**
- Modify: `puente-telegram/src/mapper.js`
- Test: `core-api/tests/bridge-mapper.test.js` (ampliar)

**Interfaces:**
- `mapUpdate` agrega el campo opcional `nombre` (de `msg.from?.first_name`, sin romper el shape actual — los tests existentes que usan `toEqual` deben actualizarse para incluir `nombre` cuando corresponda, o el campo se omite si no hay `from`). Aplica a texto, comando, foto, audio, video, documento (donde ya se arma el objeto de salida).

- [ ] **Step 1-2: Test + RED** — actualizar los `toEqual` existentes que ahora incluyen `nombre`; agregar un caso sin `msg.from` (updates de canal, por ejemplo) donde `nombre` es `null`.
- [ ] **Step 3: Implementar** — una línea por rama de retorno, o un wrapper que agregue `nombre` al objeto final antes de devolver.
- [ ] **Step 4: Suite completa** — PASS.
- [ ] **Step 5: Commit** — `git add puente-telegram/src/mapper.js core-api/tests/bridge-mapper.test.js && git commit -m "feat(puente): capturar nombre del remitente para el alta por invitacion"`

---

### Task 4: Redención de invitación (ruta pública) + integración n8n

**Files:**
- Create: `core-api/src/routes/invitations.js`
- Modify: `core-api/src/app.js`, `n8n/src/01-preparar-turno.js`, `n8n/build-workflow.mjs`
- Create: `n8n/src/04-armar-unirme.js`
- Test: `core-api/tests/invitations-redeem.test.js`, ampliar `core-api/tests/n8n-nodes.test.js`, ampliar `core-api/tests/n8n-workflow.test.js`

**Interfaces:**
- `POST /api/invitations/redeem` — **montada ANTES de `authMiddleware`** en `app.js` (sin header de identidad). Body `{code, chatId, nombre}`. Lógica: busca `invitations` por `code`; no existe/usada/vencida → 200 `{ok:false, texto:'Ese código no es válido o ya venció.'}` (siempre 200 con `{ok, texto}` — esto lo consume un nodo n8n sin necesidad de manejar status codes de error); si válido: busca o crea `users` por `telegram_chat_id=chatId` (si existe y `suspendido` → `{ok:false, texto:'Tu cuenta está suspendida.'}`; si no existe, INSERT `activo` con `name=nombre||'Invitado'`); INSERT `user_profile_access` (`ON CONFLICT DO UPDATE SET role=excluded.role` — permite re-invitar con otro rol); UPDATE `invitations` SET `used_by`, `used_at`; responde `{ok:true, texto:'✅ Listo, ya formás parte de {marca} como {rol}. Mandame una foto o un audio para empezar.'}`.
- n8n: `01-preparar-turno.js` — si `b.tipo==='comando'` y `comando` empieza con `/unirme` → `camino:'unirme'` con `{chatId, nombre: b.nombre||null, code: (texto tras /unirme).trim()}` (en vez de `camino:'turno'`). `04-armar-unirme.js` — toma la respuesta de `POST /redeem` (fullResponse) y arma `{responder:true, chatId, texto: body.texto}` (403/error de red también caen acá con fallback amable, igual que los otros nodos de armado).
- Workflow: `Switch camino` gana una 4.ª salida `unirme` → `Redimir invitacion` (HTTP POST `{{$env.CORE_API_URL}}/api/invitations/redeem`, SIN header de identidad, body `{code, chatId, nombre}`, fullResponse, neverError true, onError continue, timeout 30000) → `Armar unirme` (Code) → converge en `¿Responder?` (reutiliza el nodo existente).

- [ ] **Step 1-2: Test + RED** — ruta: código válido crea usuario nuevo + acceso + marca usada (no se puede reusar); código válido con usuario ya existente activo reutiliza la fila; usuario suspendido rechazado; código vencido/inexistente/usado rechazado con mensaje genérico (no filtra qué perfil existe). Nodos: `/unirme ABC123` → camino unirme con code extraído; `04-armar-unirme` con `{ok:true,texto}` y con `{ok:false,texto}` ambos arman `responder:true`. Workflow: nuevo nodo y conexión presentes, `Redimir invitacion` SIN header `X-Telegram-Chat-Id` (a diferencia de los otros dos HTTP) y con los mismos flags de resiliencia.
- [ ] **Step 3: Implementar** todo lo anterior; regenerar `node n8n/build-workflow.mjs`.
- [ ] **Step 4: Suite completa** — PASS; `git status --short n8n/` limpio tras rebuild.
- [ ] **Step 5: Commit** — `git add core-api/src/routes/invitations.js core-api/src/app.js n8n/src/01-preparar-turno.js n8n/src/04-armar-unirme.js n8n/build-workflow.mjs core-api/tests/ && git commit -m "feat(core-api,n8n): redencion de invitaciones sin autenticacion previa"`

---

### Task 5: `/conectar` — carga guiada de credenciales de canal

**Files:**
- Modify: `core-api/src/services/editorial.js` (o nuevo `core-api/src/services/channels.js`), `core-api/src/routes/profiles.js`, `core-api/src/agent/next-turn.js`
- Test: `core-api/tests/next-turn-conectar.test.js`

**Interfaces:**
- Helper compartido `conectarCanal(db, {profileId, channelCode, credentials, handle})` en `editorial.js` (o archivo nuevo si crece): mismo INSERT/UPSERT que hoy vive inline en `routes/profiles.js` `POST /:id/channels` (refactor: la ruta pasa a llamar este helper, sin cambiar su comportamiento observable — tests existentes de `profile-channels.test.js` deben seguir verdes).
- `next-turn.js`, comando `/conectar`: solo `owner`. Resuelve perfil (mismo patrón que `/invitar`: único → directo, varios → botones). Estado `conectando_canal`, `data:{profileId, paso:'canal'}`. Responde con botones `conectar_linkedin` / `conectar_instagram`.
- `handleBoton` nuevo caso `conectar_linkedin`/`conectar_instagram`: fija `data.channel`, `data.paso='campo_0'`, `data.borrador={}`, pregunta el primer campo (`access_token` para ambos — mensaje: 'Pegame el access_token de LinkedIn (lo sacás de tu app en linkedin.com/developers)').
- `handleTexto` en estado `conectando_canal`: guarda `data.borrador[campoActual] = texto.trim()`, avanza `paso`. Campos por canal: `linkedin: ['access_token','person_urn']`, `instagram: ['access_token','ig_user_id']`. Al completar todos: `conectarCanal(db, {profileId, channelCode, credentials: borrador})`, limpia sesión, responde `✅ {Canal} conectado (token terminado en ...{últimos 4}). Ya se puede publicar ahí.`. Nunca ecoar el token completo en ningún mensaje de esta secuencia (ni al confirmar el campo intermedio: responder '✅ Guardado. Ahora pasame {siguiente}' sin repetir lo que mandó el usuario).

- [ ] **Step 1-2: Test + RED** — flujo completo LinkedIn (2 campos) y Instagram (2 campos) hasta `profile_channels` con `credentials_enc` que desencripta a lo esperado; owner con 2 perfiles elige con botón antes de arrancar; no-owner rechazado; el texto de confirmación intermedio y final nunca contiene el valor completo del token (solo los últimos 4 caracteres en el mensaje final).
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Suite completa** — PASS.
- [ ] **Step 5: Commit** — `git add core-api/src/services/editorial.js core-api/src/routes/profiles.js core-api/src/agent/next-turn.js core-api/tests/next-turn-conectar.test.js && git commit -m "feat(core-api): conectar canales por conversacion guiada"`

---

### Task 6: Backup diario + guía completa de la Mac mini

**Files:**
- Create: `scripts/backup.sh`, `scripts/restore.sh`
- Modify: `README.md`, `.env.example`, `docker-compose.yml` (si hace falta exponer el volumen para el script)

**Interfaces:**
- `scripts/backup.sh`: para de forma segura no hace falta parar contenedores (SQLite WAL + `docker run --rm` leyendo el volumen es consistente para uso doméstico); crea `docker run --rm -v pbos_data:/data -v "$(pwd)/backups:/backup" alpine tar czf /backup/pbos-$(date +%F).tar.gz -C / data`, cifra con `openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE` (lee `BACKUP_PASSPHRASE` de `.env`), borra el `.tar.gz` sin cifrar, borra backups cifrados de más de 30 días. Falla ruidosamente (`set -euo pipefail`) — un backup roto se tiene que notar, no fallar en silencio.
- `scripts/restore.sh`: toma un archivo `.tar.gz.enc` por argumento, descifra, para los contenedores, restaura el volumen, informa reiniciar con `docker compose up -d`.
- `.env.example`: agregar `BACKUP_PASSPHRASE=` (comentario: generar con `openssl rand -base64 32`).
- README: sección nueva "## Backup" (cron sugerido: `0 3 * * * cd /ruta/al/repo && ./scripts/backup.sh >> backup.log 2>&1`, cómo restaurar, dónde guardar la passphrase — NUNCA en el repo). Sección nueva "## Multiusuario e invitaciones" (`/marca`, `/invitar`, `/unirme`, `/conectar`, roles). Sección "## OAuth y acceso remoto (Tailscale)" — explica que el callback OAuth de LinkedIn/Instagram necesita una URL alcanzable; para v1 la carga de credenciales es manual (`/conectar` pide el token ya generado, no hace el flujo OAuth completo — eso queda para v1.5/SaaS); documentar cómo instalar Tailscale en la Mac mini para acceso remoto seguro a n8n/tablero sin exponer puertos a Internet, y cómo generar los tokens de LinkedIn/Instagram a mano (Developer Portal de cada plataforma) para pegarlos en `/conectar`. Estado del README → "Plan E (v1 completo)".

- [ ] **Step 1: Escribir los scripts** con permisos ejecutables (`chmod +x`).
- [ ] **Step 2: Escribir la documentación** (sin tests automatizados — son scripts de infraestructura; se verifican manualmente en la Mac mini, documentado en el checklist final).
- [ ] **Step 3: Suite completa una vez más** (no debería cambiar nada del lado Node) — PASS.
- [ ] **Step 4: Commit** — `git add scripts/ README.md .env.example && git commit -m "feat: backup diario cifrado y guia completa de despliegue"`

---

## Self-Review del plan (ejecutada)

1. **Cobertura vs spec:** §5 multiusuario completo (owner/editor/approver ya existía; ahora se puede invitar de verdad), spec principio rector "sumar marca = configurar perfil, cero código" (`/marca` + `/conectar`), §7-credenciales "alta y renovación 100% conversacionales" (T5), §9 despliegue (backup diario explícito en el spec), OAuth/Tailscale mencionados en spec §7 como pendientes — documentados honestamente como manuales en v1 (no se promete un flujo OAuth automático que no se construyó).
2. **Decisión de arquitectura justificada:** la ruta pública `/redeem` es la única forma de resolver el problema de "usuario nuevo no puede autenticarse para autenticarse" sin inventar un canal paralelo — acotada al mínimo (un solo endpoint, valida código antes de tocar nada, nunca filtra información de perfiles ajenos en el mensaje de error).
3. **Placeholders:** ninguno; cada task tiene contrato de test completo y código de referencia donde el comportamiento es mecánico (T1, T3, T6); T2/T4/T5 siguen el patrón "skeleton + contrato de test exhaustivo" ya probado en C1-T5 para la lógica de estados nueva.
4. **Consistencia:** `crearPerfilConWaStatus`/`conectarCanal` como helpers compartidos entre REST y conversación (nunca dos caminos que hagan lo mismo distinto); botones nuevos (`conectar_linkedin`, `conectar_instagram`, `perfil_<id>` reutilizado) no colisionan con los ids ya usados en C1.
