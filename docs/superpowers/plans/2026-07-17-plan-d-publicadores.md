# Plan D — Publicadores y scheduler (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que lo aprobado se publique solo: scheduler que despacha versiones programadas, publicadores LinkedIn (API completa), Instagram (automática si hay URL pública de media; si no, degrada a paquete manual) y paquete manual por Telegram (WA Status y fallback universal), con reintentos 1/5/15 min, degradación honesta, `publish_log` auditado, `dry_run`, y vigilancia diaria de salud de tokens.

**Architecture:** Todo en core-api. `src/publishers/` (un módulo por `publisher_module` del catálogo + registry), `src/services/telegram.js` (avisos y paquetes al dueño vía Bot API), `src/services/scheduler.js` (tick de 60 s montado en server.js). Regla madre (spec §7): un contenido aprobado JAMÁS se pierde ni queda en el limbo.

**Plan series:** A ✅ B1 ✅ B2 ✅ C1 ✅ C2 ✅ · **D (este)** · E.

## Global Constraints

- Contrato del publicador: `publicar(db, version, deps) → { ok: true, url? } | { ok: true, manual: true } | { ok: false, retryable: true, error }`. `deps = { fetchImpl?, dryRun? }`. Jamás lanza — todo error se captura y clasifica.
- `DRY_RUN=1` (env): los publicadores loguean y devuelven `{ ok: true, url: 'dry-run' }` sin llamar APIs (spec §8.3).
- Reintentos con backoff: intento N se permite recién pasados [0, 1, 5, 15] minutos del intento anterior (N=1 inmediato). Tras el 3.º fallo → degradación: paquete manual por Telegram + status `entregada_manual`. Cada intento → fila en `publish_log` (attempt, ok, response_json).
- Idempotencia dura: antes de publicar, si `status != 'programada'` se saltea; tras éxito, `status='publicada'` + `published_url`. Migración: `CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_draft_channel ON channel_versions(draft_id, profile_channel_id)` aplicada SIEMPRE en `openDb` (idempotente, cubre DBs existentes).
- LinkedIn (module `linkedin`): credenciales `{access_token, person_urn}` vía `decryptJson`. Texto: `POST https://api.linkedin.com/v2/ugcPosts` (header `X-Restli-Protocol-Version: 2.0.0`, author = person_urn, `com.linkedin.ugc.ShareContent` NONE). Con imagen: `registerUpload` (`POST /v2/assets?action=registerUpload`) → PUT binario a `uploadUrl` → ugcPost con media asset (shareMediaCategory IMAGE). URL resultante: `https://www.linkedin.com/feed/update/{id-del-post}`. Texto = `text_content` + '\n\n' + hashtags (si hay).
- Instagram (module `instagram`): requiere URL pública de la imagen. Si env `MEDIA_PUBLIC_BASE_URL` está definida (ej. túnel/hosting que sirve `/data/media`): `POST /v{VER}/{ig_user_id}/media` con `image_url={base}/{basename(media_path)}` y `caption` → `POST /{ig_user_id}/media_publish` con `creation_id`; credenciales `{access_token, ig_user_id}`; base `https://graph.facebook.com/v21.0`. Sin `MEDIA_PUBLIC_BASE_URL` o sin media → devuelve `{ok:false, retryable:false, degrade:true, reason}` → el scheduler manda paquete manual (decisión registrada: la API de IG no acepta binario directo para fotos de feed; sin exponer la Mac mini el default v1 honesto es paquete manual — spec §1 "lo fácil se automatiza, lo demás paquete listo").
- Manual (module `manual`): manda al chat del creador (vía `ideas.created_by → users.telegram_chat_id`) el paquete: `sendPhoto` (si media_path) con caption = texto+hashtags, si no `sendMessage`; agrega instrucción por canal (wa_status: 'Subilo a tu estado de WhatsApp 👆'). Devuelve `{ok:true, manual:true}` → status `entregada_manual`.
- Token health: una vez por día (guard por tabla/fila en sessions? NO — archivo simple: última corrida en `data_json` de una fila `sessions` con user_id 0 es hack; usar tabla existente `publish_log`? Decisión: variable en memoria del proceso + corrida al boot — suficiente v1): `profile_channels` `conectado` con `token_expires_at` no nulo y ≤ 7 días → aviso Telegram a cada owner del perfil.
- Scheduler en `server.js`: `setInterval(() => tick(db).catch(console.error), 60000)` + un tick al boot. `tick` también dispara tokenHealth si pasaron ≥24 h de la última (en memoria).
- Todos los HTTP con `fetchImpl` inyectable; tests sin red; sin secretos en claro en logs (jamás loguear access_token). Español. TDD. Branch `claude/nuevo-proyecto-dxakbn`. Git email noreply@anthropic.com.

## File Structure

```
core-api/src/db.js                    # (modif) índice único idempotente
core-api/src/services/editorial.js    # (modif) pendingFor + drafts aprobados sin versiones
core-api/src/services/telegram.js     # sendMessage/sendPhoto al bot
core-api/src/publishers/index.js      # registry + publicar() + dry run
core-api/src/publishers/manual.js
core-api/src/publishers/linkedin.js
core-api/src/publishers/instagram.js
core-api/src/services/scheduler.js    # tick + reintentos + degradación + token health
core-api/src/server.js                # (modif) intervalo
core-api/tests/{migracion,telegram-notify,publisher-manual,publisher-linkedin,publisher-instagram,scheduler}.test.js
README.md / .env.example              # (modif)
```

---

### Task 1: Migración de índice único + visibilidad de aprobados

**Files:** Modify `core-api/src/db.js`, `core-api/src/services/editorial.js`; Test `core-api/tests/migracion.test.js`.

**Interfaces:** `openDb` ejecuta SIEMPRE (fresh y existente): `CREATE UNIQUE INDEX IF NOT EXISTS idx_cv_draft_channel ON channel_versions(draft_id, profile_channel_id)`. `pendingFor` suma clave `aprobados`: drafts `aprobado` de ideas del usuario cuyos drafts no tienen NINGUNA channel_version (SELECT d... WHERE d.status='aprobado' AND NOT EXISTS (SELECT 1 FROM channel_versions v WHERE v.draft_id = d.id)) con `{id, profile, title}`.

Tests (contrato): (1) índice existe tras openDb fresh (`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cv_draft_channel'`); (2) reabrir la misma DB no falla (idempotencia); (3) INSERT duplicado (draft_id, profile_channel_id) lanza SQLITE_CONSTRAINT; (4) `pendingFor(...).aprobados` lista un draft aprobado sin versiones y NO lista uno con versión.

TDD → commit `feat(core-api): indice unico de versiones y visibilidad de aprobados sin canal`.

---

### Task 2: Notificador Telegram del core

**Files:** Create `core-api/src/services/telegram.js`; Test `core-api/tests/telegram-notify.test.js`.

**Interfaces:** `sendMessage(chatId, text, {fetchImpl?}) → {ok}` y `sendPhotoFile(chatId, filePath, caption, {fetchImpl?}) → {ok}` — Bot API con `TELEGRAM_BOT_TOKEN` (sin token → `{ok:false, reason:'sin TELEGRAM_BOT_TOKEN'}`, sin lanzar). `sendPhotoFile` usa multipart FormData con Blob del archivo (readFileSync) campo `photo` + `chat_id` + `caption` (truncada a 1024 — límite caption Telegram). No-ok HTTP → `{ok:false, reason}` (sin token en el reason). Jamás lanza.

Tests: URL correcta sendMessage; multipart en sendPhoto con caption truncada; sin token → ok:false sin llamar fetch; HTTP 500 → ok:false y el reason NO contiene el token.

Commit `feat(core-api): notificador telegram del nucleo`.

---

### Task 3: Contrato publicador + registry + manual

**Files:** Create `core-api/src/publishers/index.js`, `core-api/src/publishers/manual.js`; Test `core-api/tests/publisher-manual.test.js`.

**Interfaces:**
- `index.js`: `publicar(db, versionRow, deps) → resultado` — resuelve el módulo por `channels.publisher_module` (join vía profile_channels); `DRY_RUN` env o `deps.dryRun` → `{ok:true, url:'dry-run'}` sin tocar módulos; módulo desconocido/null → delega a `manual`; captura excepciones del módulo → `{ok:false, retryable:true, error:String(err)}`. Expone también `contextoDe(db, versionId) → {version, draft, idea, profile, channelCode, credentials|null, creatorChatId}` (helper que arma todo lo que un módulo necesita; credentials via decryptJson con try/catch → null).
- `manual.js`: `publicarManual(ctx, deps) → {ok:true, manual:true}` — usa telegram.js; texto = `text_content` + hashtags + línea de instrucción por canal (`wa_status` → 'Subilo a tu estado de WhatsApp 👆'; default → `Listo para pegar en {channelCode} 👆`); con media → sendPhotoFile, sin → sendMessage. Si telegram devuelve ok:false → `{ok:false, retryable:true, error}` (el paquete no se entregó: reintentable).

Tests: dry run no llama módulos; canal wa_status → manual con sendPhoto y la instrucción; texto sin media → sendMessage; telegram caído → retryable; módulo desconocido cae a manual.

Commit `feat(core-api): contrato de publicadores, dry run y paquete manual`.

---

### Task 4: Publicador LinkedIn

**Files:** Create `core-api/src/publishers/linkedin.js`; Test `core-api/tests/publisher-linkedin.test.js`.

**Interfaces:** `publicarLinkedin(ctx, deps) → {ok:true, url} | {ok:false, retryable, error}`. Sin credentials → `{ok:false, retryable:false, degrade:true, reason:'sin credenciales linkedin'}`. Texto solo: ugcPost NONE. Con `media_path`: registerUpload → PUT binario (Authorization Bearer) → ugcPost IMAGE con asset. Respuestas no-ok: 401/403 → `{ok:false, retryable:false, degrade:true, reason:'token inválido o vencido'}`; 5xx/429 → retryable:true. El id del post sale del header `x-restli-id` o body.id → url `https://www.linkedin.com/feed/update/{id}`. Nunca loguear el token.

Tests (fetch mock): texto solo (verifica author URN, header Restli, body shareCommentary = texto+hashtags, url final del id); con imagen (3 llamadas en orden: registerUpload con recipe feedshare-image, PUT binario al uploadUrl con el buffer, ugcPost con asset y categoría IMAGE); 401 → degrade; 500 → retryable; sin credenciales → degrade.

Commit `feat(core-api): publicador linkedin (texto e imagen)`.

---

### Task 5: Publicador Instagram

**Files:** Create `core-api/src/publishers/instagram.js`; Test `core-api/tests/publisher-instagram.test.js`.

**Interfaces:** `publicarInstagram(ctx, deps)`. Guardas en orden: sin credentials → degrade 'sin credenciales instagram'; sin `media_path` → degrade 'instagram requiere imagen'; sin env `MEDIA_PUBLIC_BASE_URL` → degrade 'sin MEDIA_PUBLIC_BASE_URL (paquete manual)'. Con todo: `POST {base}/v21.0/{ig_user_id}/media` (params image_url = `${MEDIA_PUBLIC_BASE_URL}/${basename(media_path)}`, caption = texto+hashtags, access_token) → `POST .../media_publish` (creation_id) → GET permalink (`/{media_id}?fields=permalink`) → `{ok:true, url: permalink}` (si el GET falla, url = `https://www.instagram.com/` como fallback sin romper). 4xx auth → degrade; 5xx/429 → retryable.

Tests: sin base URL → degrade; flujo completo con 3 llamadas y params correctos; caption incluye hashtags; 401 → degrade; 500 en media_publish → retryable.

Commit `feat(core-api): publicador instagram (con URL publica o degradacion)`.

---

### Task 6: Scheduler con reintentos, degradación y salud de tokens

**Files:** Create `core-api/src/services/scheduler.js`; Modify `core-api/src/server.js`; Test `core-api/tests/scheduler.test.js`.

**Interfaces:**
- `tick(db, deps?) → {procesadas, publicadas, degradadas, reintentos_pendientes}`:
  1. `SELECT id FROM channel_versions WHERE status='programada' AND scheduled_at <= datetime('now')`.
  2. Por cada una: cuenta intentos previos (`SELECT COUNT(*), MAX(created_at) FROM publish_log WHERE channel_version_id=?`); si intentos>0 y no pasó el backoff [1,5,15]min desde el último → skip (reintento_pendiente). Si intentos>=3 → degradar: `publicarManual` + status `entregada_manual` + log + aviso al creador ('⚠️ {canal} no respondió; te mandé el paquete para publicarlo a mano.'). Si no: `publicar(...)`; resultado:
     - ok+url → `publicada`, published_url, log ok, aviso al creador ('✅ Publicado en {canal}: {url}').
     - ok+manual → `entregada_manual`, log ok.
     - degrade → directo a paquete manual (sin reintentos), como el caso 3 intentos.
     - retryable → log fallido (queda para el próximo tick).
  3. `tokenHealthMaybe(db, deps)`: si pasaron ≥24h desde la última corrida en memoria (export `_resetHealthClock()` para tests): perfiles `conectado` con `token_expires_at` ≤ +7 días → aviso a owners ('🔑 El token de {canal} de {perfil} vence {fecha}. Reconectalo.').
- `server.js`: tras `app.listen`: `tick(db).catch(...)` + `setInterval(..., 60000)`.

Tests (fetch mock + DB seeded como en next-turn tests): programada vencida se publica (linkedin mock ok) y pasa a `publicada` con log y aviso; fallo retryable no cambia status y loguea; backoff respeta la espera (simular publish_log con created_at reciente → skip); tercer fallo degrada a `entregada_manual` con paquete enviado; degrade de instagram sin base URL va directo a manual; aprobadas (no programadas) NO se tocan; token que vence en 3 días dispara un aviso y no se repite en el mismo día (`_resetHealthClock` entre asserts).

Commit `feat(core-api): scheduler de publicacion con reintentos y salud de tokens`.

---

### Task 7: Documentación y cierre

**Files:** Modify `README.md`, `.env.example`.

- `.env.example`: `DRY_RUN=` (comentado: 1 = simula publicaciones), `MEDIA_PUBLIC_BASE_URL=` (comentado: URL pública que sirva /data/media para Instagram; sin ella IG llega como paquete manual). Sección nueva de credenciales de canal (cómo cargar por curl `POST /api/profiles/:id/channels` con `{channel_code, credentials}` — LinkedIn `{access_token, person_urn}`, Instagram `{access_token, ig_user_id}` — nota: el Plan E lo hace conversacional).
- README: estado → Plan D; sección "## Publicación automática" (cómo funciona el scheduler, el ciclo aprobado→programada→publicada, degradación a paquete manual, DRY_RUN para probar sin publicar, expectativa de avisos por Telegram).

Suite completa; commit `docs: publicacion automatica, dry run y credenciales de canal`.

---

## Self-Review del plan (ejecutada)

1. **Cobertura vs spec §7:** contrato exacto, scheduler, 3 publicadores v1, reintentos 1/5/15, degradación a manual con aviso, publish_log por intento, validación temprana ya cubierta en C1 (formatos), idempotencia (índice único + status guard), token health con aviso proactivo, dry_run. Decisión registrada: Instagram automática solo con MEDIA_PUBLIC_BASE_URL (limitación real de la API de IG: exige URL pública para fotos; sin exponer la red, el default honesto es paquete manual). Deudas B2/C1 saldadas: UNIQUE index, aprobados visibles en /cola.
2. **Placeholders:** contratos de test exhaustivos por task (patrón C1/C2); estructuras de API LinkedIn/IG especificadas con endpoints y campos exactos.
3. **Consistencia:** `publisher_module` del seed Plan A (linkedin/instagram/manual); credenciales shape = las que documenta T7 y guarda A-T8; `ideas.created_by → users.telegram_chat_id` para el paquete; hashtags de C1-fix.
