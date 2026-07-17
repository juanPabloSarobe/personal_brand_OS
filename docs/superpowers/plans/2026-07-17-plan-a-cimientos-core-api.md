# Plan A — Cimientos: core-api (Personal Brand OS v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Levantar la core-api del Personal Brand OS: base SQLite completa, usuarios con roles y matriz de permisos, Perfiles de Marca, credenciales de canal cifradas en reposo, archivo de evidencia, todo dockerizado — probado con tests y `curl`.

**Architecture:** Un servicio Express (Node 22, ESM, JavaScript plano) dueño de los datos, siguiendo los patrones del proyecto de referencia `incident-free_systemic_learning` (API dueña de la base, SQLite WAL, media en volumen). Toda query pasa por contexto de usuario. Sin n8n ni Telegram todavía: esta capa se valida sola vía tests + curl.

**Tech Stack:** Node 22 · Express 4 · better-sqlite3 · node:crypto (AES-256-GCM) · Vitest + Supertest · Docker Compose.

**Plan series:** Este es el Plan A de 5 (A: cimientos · B: captura Telegram+n8n · C: conversación creativa · D: publicadores · E: onboarding conversacional). Spec: `docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`.

## Global Constraints

- JavaScript plano ESM (`"type": "module"`), sin TypeScript, sin transpilación (patrón del repo de referencia).
- Node 22. Imagen Docker `node:22-slim` (Debian: prebuilds de better-sqlite3 funcionan; Alpine no).
- **Ninguna query sin contexto de usuario** (spec §4.2): toda ruta bajo `/api` exige el header `X-Telegram-Chat-Id` de un usuario activo.
- Credenciales de marca **cifradas en reposo** en la DB; clave maestra `MASTER_KEY` (32 bytes hex) solo en `.env`. Decisión registrada: AES-256-GCM vía `node:crypto` en lugar de libsodium (misma garantía, cero dependencias nativas extra).
- **En git no vive ningún secreto** — solo `.env.example`.
- Textos de usuario y de la API en español; código y nombres de tablas/campos como en el spec §4.
- Media en volumen `/data` (rutas en DB, nunca blobs).
- SQLite en modo WAL, `foreign_keys = ON`.
- Roles: `editor` < `approver` < `owner` (spec §4.2). Estados de tablas: valores exactos del spec §4.
- TDD: test que falla → implementación mínima → test verde → commit.

## File Structure

```
core-api/
  package.json
  Dockerfile
  src/
    server.js          # bootstrap (puerto, señales)
    app.js             # factory de la app Express (testeable)
    db.js              # apertura, migración, seed, admin bootstrap
    schema.sql         # TODAS las tablas del spec §4
    seed.sql           # catálogo de canales y formatos
    crypto.js          # encryptJson/decryptJson AES-256-GCM
    auth.js            # middleware de identidad
    permissions.js     # matriz rol × acción
    routes/
      profiles.js      # perfiles + canales del perfil
      evidence.js      # captura de evidencia
  tests/
    helpers.js         # makeTestApp() con DB temporal
    crypto.test.js
    db.test.js
    auth.test.js
    permissions.test.js
    profiles.test.js
    profile-channels.test.js
    evidence.test.js
docker-compose.yml
.env.example
```

---

### Task 1: Esqueleto de core-api con test de humo

**Files:**
- Create: `core-api/package.json`
- Create: `core-api/src/app.js`
- Create: `core-api/src/server.js`
- Test: `core-api/tests/health.test.js`

**Interfaces:**
- Produces: `createApp(db) → express.Application` (usada por todos los tests y por `server.js`). `GET /health → 200 {"ok":true}` sin auth.

- [ ] **Step 1: Crear package.json e instalar dependencias**

```json
{
  "name": "pbos-core-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.10.0",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0",
    "vitest": "^2.1.0"
  }
}
```

Run: `cd core-api && npm install`
Expected: `node_modules/` creado sin errores de compilación (better-sqlite3 usa prebuild).

- [ ] **Step 2: Escribir el test que falla**

`core-api/tests/health.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'

describe('GET /health', () => {
  it('responde 200 sin autenticación', async () => {
    const app = createApp(null) // /health no usa la db
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
```

- [ ] **Step 3: Verificar que falla**

Run: `cd core-api && npx vitest run tests/health.test.js`
Expected: FAIL — `Cannot find module '../src/app.js'`

- [ ] **Step 4: Implementación mínima**

`core-api/src/app.js`:

```js
import express from 'express'

export function createApp(db) {
  const app = express()
  app.use(express.json({ limit: '50mb' })) // evidencia entra como base64
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.locals.db = db
  return app
}
```

`core-api/src/server.js`:

```js
import { createApp } from './app.js'
import { openDb } from './db.js'

const db = openDb()
const app = createApp(db)
const port = process.env.PORT || 3000
app.listen(port, () => console.log(`core-api escuchando en :${port}`))
```

(`db.js` llega en la Task 2; `server.js` no se ejecuta hasta entonces — el test solo usa `app.js`.)

- [ ] **Step 5: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/health.test.js`
Expected: PASS (1 test)

- [ ] **Step 6: Commit**

```bash
git add core-api/package.json core-api/package-lock.json core-api/src/app.js core-api/src/server.js core-api/tests/health.test.js
git commit -m "feat(core-api): esqueleto Express con endpoint de salud"
```

---

### Task 2: Base de datos — esquema completo y bootstrap de admin

**Files:**
- Create: `core-api/src/schema.sql`
- Create: `core-api/src/db.js`
- Test: `core-api/tests/db.test.js`

**Interfaces:**
- Produces: `openDb({ dbPath? }) → Database` (better-sqlite3). Crea el esquema si no existe, aplica seed si existe `seed.sql`, y da de alta al admin desde `ADMIN_CHAT_ID`/`ADMIN_NAME` del entorno. Tablas y campos exactamente como abajo — **todas las tasks posteriores dependen de estos nombres**.

- [ ] **Step 1: Escribir el test que falla**

`core-api/tests/db.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-db-'))
  return openDb({ dbPath: path.join(dir, 'test.db') })
}

describe('openDb', () => {
  beforeEach(() => {
    process.env.ADMIN_CHAT_ID = '111'
    process.env.ADMIN_NAME = 'Juan Pablo'
  })

  it('crea todas las tablas del spec', () => {
    const db = freshDb()
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name)
    for (const t of ['users', 'invitations', 'brand_profiles', 'user_profile_access',
      'channels', 'channel_formats', 'profile_channels', 'evidence', 'ideas',
      'idea_evidence', 'idea_profiles', 'drafts', 'channel_versions', 'sessions',
      'entities', 'entity_mentions', 'publish_log']) {
      expect(tables, `falta la tabla ${t}`).toContain(t)
    }
  })

  it('activa WAL y foreign keys', () => {
    const db = freshDb()
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('da de alta al admin desde el entorno, una sola vez', () => {
    const db = freshDb()
    const admin = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get('111')
    expect(admin.name).toBe('Juan Pablo')
    expect(admin.is_admin).toBe(1)
    expect(admin.status).toBe('activo')
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/db.test.js`
Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 3: Escribir el esquema completo**

`core-api/src/schema.sql`:

```sql
-- Personal Brand OS — esquema v1 (spec §4)

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  telegram_chat_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'activo'
    CHECK (status IN ('activo', 'invitado', 'suspendido')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE brand_profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  identity_json TEXT NOT NULL DEFAULT '{}',        -- identidad, objetivos, público, tono, temáticas, palabras, nunca_comunicar, nivel_tecnico, estilo_visual
  visual_template TEXT,                            -- plantilla Sharp (Plan C)
  cadence_json TEXT NOT NULL DEFAULT '{}',
  format_strategy_json TEXT NOT NULL DEFAULT '{}',
  ai_overrides_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'activo'
    CHECK (status IN ('activo', 'pausado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_profile_access (
  user_id INTEGER NOT NULL REFERENCES users(id),
  profile_id INTEGER NOT NULL REFERENCES brand_profiles(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'approver')),
  PRIMARY KEY (user_id, profile_id)
);

CREATE TABLE invitations (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  profile_id INTEGER NOT NULL REFERENCES brand_profiles(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'approver')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id),
  used_at TEXT
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('activo', 'reservado', 'planificado')),
  publisher_module TEXT
);

CREATE TABLE channel_formats (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  automatable INTEGER NOT NULL DEFAULT 0,
  specs_json TEXT NOT NULL DEFAULT '{}',           -- dimensiones, límites de texto, duración
  UNIQUE (channel_id, code)
);

CREATE TABLE profile_channels (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES brand_profiles(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  handle TEXT,
  credentials_enc TEXT,                            -- AES-256-GCM: iv.tag.ct en base64
  status TEXT NOT NULL DEFAULT 'desconectado'
    CHECK (status IN ('desconectado', 'conectado', 'token_por_vencer', 'token_vencido')),
  token_expires_at TEXT,
  UNIQUE (profile_id, channel_id)
);

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('foto', 'audio', 'video', 'texto', 'link')),
  file_path TEXT,
  text_content TEXT,
  transcription TEXT,                              -- Plan B (Whisper)
  vision_description TEXT,                         -- Plan B (visión)
  context_json TEXT NOT NULL DEFAULT '{}',
  raw_llm_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ideas (
  id INTEGER PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'capturada'
    CHECK (status IN ('capturada', 'en_conversacion', 'lista', 'descartada')),
  raw_llm_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE idea_evidence (
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  evidence_id INTEGER NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (idea_id, evidence_id)
);

CREATE TABLE idea_profiles (
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  profile_id INTEGER NOT NULL REFERENCES brand_profiles(id),
  PRIMARY KEY (idea_id, profile_id)
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  idea_id INTEGER NOT NULL REFERENCES ideas(id),
  profile_id INTEGER NOT NULL REFERENCES brand_profiles(id),
  content TEXT,
  status TEXT NOT NULL DEFAULT 'en_refinamiento'
    CHECK (status IN ('en_refinamiento', 'aprobado', 'descartado')),
  raw_llm_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (idea_id, profile_id)
);

CREATE TABLE channel_versions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  profile_channel_id INTEGER NOT NULL REFERENCES profile_channels(id),
  format_code TEXT NOT NULL,
  text_content TEXT,
  media_path TEXT,
  hashtags TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',            -- etiquetas @ propuestas/incluidas
  status TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'aprobada', 'programada', 'publicada', 'entregada_manual', 'cancelada')),
  scheduled_at TEXT,
  published_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  chat_id TEXT NOT NULL,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  UNIQUE (user_id, chat_id)
);

CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('persona', 'empresa', 'tecnologia', 'proyecto', 'lugar', 'evento')),
  name TEXT NOT NULL,
  handles_json TEXT NOT NULL DEFAULT '{}',         -- { "instagram": "@...", "linkedin": "..." }
  gps_lat REAL,
  gps_lon REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, name)
);

CREATE TABLE entity_mentions (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  evidence_id INTEGER REFERENCES evidence(id),
  idea_id INTEGER REFERENCES ideas(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (evidence_id IS NOT NULL OR idea_id IS NOT NULL)
);

CREATE TABLE publish_log (
  id INTEGER PRIMARY KEY,
  channel_version_id INTEGER NOT NULL REFERENCES channel_versions(id),
  attempt INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_evidence_user ON evidence(user_id, created_at);
CREATE INDEX idx_cv_status_sched ON channel_versions(status, scheduled_at);
CREATE INDEX idx_mentions_entity ON entity_mentions(entity_id);
```

- [ ] **Step 4: Implementar db.js**

`core-api/src/db.js`:

```js
import Database from 'better-sqlite3'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function openDb({ dbPath = process.env.DB_PATH || '/data/pbos.db' } = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const hasUsers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  ).get()
  if (!hasUsers) {
    db.exec(readFileSync(path.join(HERE, 'schema.sql'), 'utf8'))
    const seedPath = path.join(HERE, 'seed.sql')
    if (existsSync(seedPath)) db.exec(readFileSync(seedPath, 'utf8'))
  }

  ensureAdmin(db)
  return db
}

function ensureAdmin(db) {
  const chatId = process.env.ADMIN_CHAT_ID
  if (!chatId) return
  const exists = db.prepare('SELECT id FROM users WHERE telegram_chat_id = ?').get(String(chatId))
  if (!exists) {
    db.prepare(
      "INSERT INTO users (telegram_chat_id, name, status, is_admin) VALUES (?, ?, 'activo', 1)"
    ).run(String(chatId), process.env.ADMIN_NAME || 'Admin')
  }
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/db.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add core-api/src/schema.sql core-api/src/db.js core-api/tests/db.test.js
git commit -m "feat(core-api): esquema SQLite completo del spec y bootstrap de admin"
```

---

### Task 3: Seed del catálogo de canales y formatos

**Files:**
- Create: `core-api/src/seed.sql`
- Test: `core-api/tests/db.test.js` (agregar casos)

**Interfaces:**
- Produces: filas de `channels` (códigos exactos: `linkedin`, `instagram`, `wa_status`, `telegram_channel`, `x`, `threads`, `bluesky`, `tiktok`, `youtube`, `sitio_propio`) y `channel_formats` — el Plan C/D las consulta por `code`.

- [ ] **Step 1: Agregar el test que falla**

Agregar a `core-api/tests/db.test.js` dentro del `describe('openDb', ...)`:

```js
  it('siembra el catálogo de canales del máster plan', () => {
    const db = freshDb()
    const codes = db.prepare('SELECT code, status FROM channels ORDER BY code').all()
    const byCode = Object.fromEntries(codes.map(c => [c.code, c.status]))
    expect(byCode.linkedin).toBe('activo')
    expect(byCode.instagram).toBe('activo')
    expect(byCode.wa_status).toBe('activo')
    expect(byCode.x).toBe('planificado')
    expect(byCode.tiktok).toBe('planificado')
    expect(byCode.youtube).toBe('planificado')
  })

  it('siembra formatos con bandera de automatizable', () => {
    const db = freshDb()
    const li = db.prepare(`
      SELECT f.code, f.automatable FROM channel_formats f
      JOIN channels c ON c.id = f.channel_id WHERE c.code = 'linkedin'
    `).all()
    const codes = li.map(f => f.code)
    expect(codes).toEqual(expect.arrayContaining(['texto', 'imagen', 'video', 'documento']))
    const wa = db.prepare(`
      SELECT f.automatable FROM channel_formats f
      JOIN channels c ON c.id = f.channel_id WHERE c.code = 'wa_status'
    `).get()
    expect(wa.automatable).toBe(0)
  })
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/db.test.js`
Expected: FAIL — los dos tests nuevos (tabla `channels` vacía)

- [ ] **Step 3: Escribir el seed**

`core-api/src/seed.sql`:

```sql
-- Catálogo de canales (máster plan, spec §10)
INSERT INTO channels (code, name, status, publisher_module) VALUES
  ('linkedin',         'LinkedIn',          'activo',      'linkedin'),
  ('instagram',        'Instagram',         'activo',      'instagram'),
  ('wa_status',        'WhatsApp Status',   'activo',      'manual'),
  ('telegram_channel', 'Canal de Telegram', 'planificado', NULL),
  ('x',                'X (Twitter)',       'planificado', NULL),
  ('threads',          'Threads',           'planificado', NULL),
  ('bluesky',          'Bluesky',           'planificado', NULL),
  ('tiktok',           'TikTok',            'planificado', NULL),
  ('youtube',          'YouTube',           'planificado', NULL),
  ('sitio_propio',     'Sitio propio',      'planificado', NULL);

-- Formatos por canal (spec §6). automatable: 1 = publica la API, 0 = paquete manual
INSERT INTO channel_formats (channel_id, code, name, automatable, specs_json) VALUES
  ((SELECT id FROM channels WHERE code='linkedin'), 'texto',     'Post de texto',        1, '{"max_chars":3000}'),
  ((SELECT id FROM channels WHERE code='linkedin'), 'imagen',    'Post con imagen',      1, '{"max_chars":3000,"max_imgs":9}'),
  ((SELECT id FROM channels WHERE code='linkedin'), 'video',     'Post con video',       1, '{"max_chars":3000}'),
  ((SELECT id FROM channels WHERE code='linkedin'), 'documento', 'Documento (carrusel)', 1, '{"formato":"pdf"}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'feed',     'Foto en feed',         1, '{"aspect":"1:1|4:5","max_chars":2200}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'carrusel', 'Carrusel',             1, '{"max_items":10,"max_chars":2200}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'historia', 'Historia',             1, '{"aspect":"9:16"}'),
  ((SELECT id FROM channels WHERE code='instagram'), 'reel',     'Reel',                 0, '{"aspect":"9:16","max_seg":90,"nota":"v2: pipeline de video"}'),
  ((SELECT id FROM channels WHERE code='wa_status'), 'historia', 'Estado',               0, '{"aspect":"9:16","entrega":"paquete_manual"}');
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/db.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/seed.sql core-api/tests/db.test.js
git commit -m "feat(core-api): seed del catálogo de canales y formatos del máster plan"
```

---

### Task 4: Cifrado de credenciales (AES-256-GCM)

**Files:**
- Create: `core-api/src/crypto.js`
- Test: `core-api/tests/crypto.test.js`

**Interfaces:**
- Produces: `encryptJson(obj) → string` (formato `iv.tag.ct` en base64) y `decryptJson(string) → obj`. Lee `MASTER_KEY` (64 chars hex) del entorno. Usadas por la ruta de canales (Task 8) y por los publicadores (Plan D).

- [ ] **Step 1: Escribir el test que falla**

`core-api/tests/crypto.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { encryptJson, decryptJson } from '../src/crypto.js'

describe('crypto', () => {
  beforeEach(() => {
    process.env.MASTER_KEY = 'ab'.repeat(32) // 64 chars hex
  })

  it('cifra y descifra un objeto (round-trip)', () => {
    const secret = { access_token: 'tok-123', refresh_token: 'ref-456' }
    const blob = encryptJson(secret)
    expect(blob).not.toContain('tok-123')
    expect(decryptJson(blob)).toEqual(secret)
  })

  it('dos cifrados del mismo objeto difieren (IV aleatorio)', () => {
    const secret = { a: 1 }
    expect(encryptJson(secret)).not.toBe(encryptJson(secret))
  })

  it('rechaza MASTER_KEY inválida', () => {
    process.env.MASTER_KEY = 'corta'
    expect(() => encryptJson({ a: 1 })).toThrow(/MASTER_KEY/)
  })

  it('detecta manipulación del blob', () => {
    const blob = encryptJson({ a: 1 })
    const roto = blob.slice(0, -4) + 'AAAA'
    expect(() => decryptJson(roto)).toThrow()
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/crypto.test.js`
Expected: FAIL — `Cannot find module '../src/crypto.js'`

- [ ] **Step 3: Implementar**

`core-api/src/crypto.js`:

```js
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

function masterKey() {
  const hex = process.env.MASTER_KEY || ''
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MASTER_KEY debe ser 32 bytes en hex (64 caracteres)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptJson(obj) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join('.')
}

export function decryptJson(blob) {
  const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv)
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'))
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/crypto.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/crypto.js core-api/tests/crypto.test.js
git commit -m "feat(core-api): cifrado AES-256-GCM para credenciales de canal"
```

---

### Task 5: Identidad — middleware de autenticación por chat ID

**Files:**
- Create: `core-api/src/auth.js`
- Create: `core-api/tests/helpers.js`
- Modify: `core-api/src/app.js`
- Test: `core-api/tests/auth.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 2).
- Produces: `authMiddleware(db)` — pobla `req.user` (fila completa de `users`) o corta con 401/403; `GET /api/me → {id, name, is_admin}`; `makeTestApp() → { app, db }` (helper que TODOS los tests posteriores usan: admin chat `111` ya activo, `MASTER_KEY` seteada, media en tmp).

- [ ] **Step 1: Escribir el helper de tests**

`core-api/tests/helpers.js`:

```js
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'

export const ADMIN_CHAT = '111'

export function makeTestApp() {
  process.env.MASTER_KEY = 'ab'.repeat(32)
  process.env.ADMIN_CHAT_ID = ADMIN_CHAT
  process.env.ADMIN_NAME = 'Juan Pablo'
  const dir = mkdtempSync(path.join(tmpdir(), 'pbos-'))
  process.env.MEDIA_DIR = path.join(dir, 'media')
  const db = openDb({ dbPath: path.join(dir, 'test.db') })
  return { app: createApp(db), db }
}

/** Da de alta un usuario activo y devuelve su chat_id. */
export function addUser(db, chatId, name = `Usuario ${chatId}`) {
  db.prepare(
    "INSERT INTO users (telegram_chat_id, name, status) VALUES (?, ?, 'activo')"
  ).run(String(chatId), name)
  return String(chatId)
}
```

- [ ] **Step 2: Escribir el test que falla**

`core-api/tests/auth.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'

describe('autenticación', () => {
  it('401 sin header de identidad', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/api/me')
    expect(res.status).toBe(401)
  })

  it('403 para chat ID desconocido (silencio administrativo)', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/api/me').set('X-Telegram-Chat-Id', '999')
    expect(res.status).toBe(403)
  })

  it('403 para usuario suspendido', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '222')
    db.prepare("UPDATE users SET status='suspendido' WHERE telegram_chat_id='222'").run()
    const res = await request(app).get('/api/me').set('X-Telegram-Chat-Id', '222')
    expect(res.status).toBe(403)
  })

  it('devuelve la identidad del usuario activo', async () => {
    const { app } = makeTestApp()
    const res = await request(app).get('/api/me').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Juan Pablo')
    expect(res.body.is_admin).toBe(1)
  })
})
```

- [ ] **Step 3: Verificar que falla**

Run: `cd core-api && npx vitest run tests/auth.test.js`
Expected: FAIL — `Cannot find module '../src/auth.js'` (vía app.js) o 404 en `/api/me`

- [ ] **Step 4: Implementar**

`core-api/src/auth.js`:

```js
export function authMiddleware(db) {
  return (req, res, next) => {
    const chatId = req.get('X-Telegram-Chat-Id')
    if (!chatId) return res.status(401).json({ error: 'falta X-Telegram-Chat-Id' })
    const user = db.prepare(
      "SELECT * FROM users WHERE telegram_chat_id = ? AND status = 'activo'"
    ).get(String(chatId))
    if (!user) return res.status(403).json({ error: 'usuario no autorizado' })
    req.user = user
    next()
  }
}
```

Modificar `core-api/src/app.js` para quedar así:

```js
import express from 'express'
import { authMiddleware } from './auth.js'

export function createApp(db) {
  const app = express()
  app.use(express.json({ limit: '50mb' })) // evidencia entra como base64
  app.get('/health', (_req, res) => res.json({ ok: true }))

  if (db) {
    const api = express.Router()
    api.use(authMiddleware(db))
    api.get('/me', (req, res) => {
      const { id, name, is_admin } = req.user
      res.json({ id, name, is_admin })
    })
    app.use('/api', api)
    app.locals.api = api // los routers de rutas se montan acá en tasks siguientes
  }

  app.locals.db = db
  return app
}
```

- [ ] **Step 5: Verificar que pasa (toda la suite)**

Run: `cd core-api && npx vitest run`
Expected: PASS — health, db, crypto y auth en verde

- [ ] **Step 6: Commit**

```bash
git add core-api/src/auth.js core-api/src/app.js core-api/tests/helpers.js core-api/tests/auth.test.js
git commit -m "feat(core-api): identidad por chat ID con silencio administrativo"
```

---

### Task 6: Matriz de permisos rol × acción

**Files:**
- Create: `core-api/src/permissions.js`
- Test: `core-api/tests/permissions.test.js`

**Interfaces:**
- Consumes: tablas `users`, `brand_profiles`, `user_profile_access`.
- Produces: `can(db, userId, profileId, action) → boolean` y `roleFor(db, userId, profileId) → 'owner'|'editor'|'approver'|null`. Acciones exactas: `ver_perfil`, `capturar`, `editar_boceto`, `aprobar`, `programar`, `editar_perfil`, `gestionar_canales`, `invitar`. Usadas por TODAS las rutas con `:profileId` de este plan y los siguientes.

- [ ] **Step 1: Escribir el test que falla**

`core-api/tests/permissions.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { makeTestApp, addUser } from './helpers.js'
import { can, roleFor } from '../src/permissions.js'

function setup() {
  const { db } = makeTestApp()
  addUser(db, '222', 'Editora')
  const editor = db.prepare("SELECT id FROM users WHERE telegram_chat_id='222'").get().id
  const owner = db.prepare("SELECT id FROM users WHERE telegram_chat_id='111'").get().id
  const profile = db.prepare(
    "INSERT INTO brand_profiles (name, slug) VALUES ('SkyTrace', 'skytrace')"
  ).run().lastInsertRowid
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'owner')").run(owner, profile)
  db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'editor')").run(editor, profile)
  return { db, owner, editor, profile }
}

describe('matriz de permisos', () => {
  it('editor captura y edita pero NO aprueba', () => {
    const { db, editor, profile } = setup()
    expect(can(db, editor, profile, 'capturar')).toBe(true)
    expect(can(db, editor, profile, 'editar_boceto')).toBe(true)
    expect(can(db, editor, profile, 'aprobar')).toBe(false)
    expect(can(db, editor, profile, 'gestionar_canales')).toBe(false)
  })

  it('owner puede todo', () => {
    const { db, owner, profile } = setup()
    for (const a of ['ver_perfil', 'capturar', 'aprobar', 'editar_perfil', 'gestionar_canales', 'invitar']) {
      expect(can(db, owner, profile, a), a).toBe(true)
    }
  })

  it('sin fila en la matriz no hay acceso alguno', () => {
    const { db, profile } = setup()
    addUser(db, '333')
    const outsider = db.prepare("SELECT id FROM users WHERE telegram_chat_id='333'").get().id
    expect(roleFor(db, outsider, profile)).toBeNull()
    expect(can(db, outsider, profile, 'ver_perfil')).toBe(false)
  })

  it('acción desconocida lanza error (fail-closed explícito)', () => {
    const { db, owner, profile } = setup()
    expect(() => can(db, owner, profile, 'publicar_sin_aprobar')).toThrow(/desconocida/)
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/permissions.test.js`
Expected: FAIL — `Cannot find module '../src/permissions.js'`

- [ ] **Step 3: Implementar**

`core-api/src/permissions.js`:

```js
const RANK = { editor: 1, approver: 2, owner: 3 }

const MIN_ROLE = {
  ver_perfil: 'editor',
  capturar: 'editor',
  editar_boceto: 'editor',
  aprobar: 'approver',
  programar: 'approver',
  editar_perfil: 'owner',
  gestionar_canales: 'owner',
  invitar: 'owner',
}

export function roleFor(db, userId, profileId) {
  const row = db.prepare(
    'SELECT role FROM user_profile_access WHERE user_id = ? AND profile_id = ?'
  ).get(userId, profileId)
  return row ? row.role : null
}

export function can(db, userId, profileId, action) {
  const min = MIN_ROLE[action]
  if (!min) throw new Error(`acción desconocida: ${action}`)
  const role = roleFor(db, userId, profileId)
  return role !== null && RANK[role] >= RANK[min]
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd core-api && npx vitest run tests/permissions.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add core-api/src/permissions.js core-api/tests/permissions.test.js
git commit -m "feat(core-api): matriz de permisos rol x accion, fail-closed"
```

---

### Task 7: Perfiles de Marca — rutas con aislamiento por usuario

**Files:**
- Create: `core-api/src/routes/profiles.js`
- Modify: `core-api/src/app.js`
- Test: `core-api/tests/profiles.test.js`

**Interfaces:**
- Consumes: `can` (Task 6), `authMiddleware` vía `/api` (Task 5).
- Produces: `profilesRouter(db)` montado en `/api/profiles`:
  - `GET /api/profiles` → solo perfiles del usuario, con su `role`
  - `POST /api/profiles {name, slug, identity?}` → 201 `{id}` (solo admin; otorga `owner` al creador)
  - `GET /api/profiles/:id` → 403 sin acceso
  - `PUT /api/profiles/:id` → solo `owner`; campos permitidos: `name`, `identity_json`, `cadence_json`, `format_strategy_json`, `ai_overrides_json`, `visual_template`

- [ ] **Step 1: Escribir el test que falla**

`core-api/tests/profiles.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'

describe('perfiles de marca', () => {
  it('admin crea un perfil y queda como owner', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'Juan Pablo', slug: 'juanpablo', identity: { tono: 'primera persona' } })
    expect(res.status).toBe(201)
    const list = await request(app).get('/api/profiles').set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].role).toBe('owner')
  })

  it('no-admin no puede crear perfiles', async () => {
    const { app, db } = makeTestApp()
    addUser(db, '222')
    const res = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', '222')
      .send({ name: 'X', slug: 'x' })
    expect(res.status).toBe(403)
  })

  it('AISLAMIENTO: el usuario B no ve ni accede al perfil de A', async () => {
    const { app, db } = makeTestApp()
    const created = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'SkyTrace', slug: 'skytrace' })
    addUser(db, '222')
    const list = await request(app).get('/api/profiles').set('X-Telegram-Chat-Id', '222')
    expect(list.body).toEqual([])
    const detail = await request(app).get(`/api/profiles/${created.body.id}`)
      .set('X-Telegram-Chat-Id', '222')
    expect(detail.status).toBe(403)
  })

  it('solo owner edita el perfil', async () => {
    const { app, db } = makeTestApp()
    const created = await request(app).post('/api/profiles')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ name: 'SkyTrace', slug: 'skytrace' })
    addUser(db, '222')
    const editorId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='222'").get().id
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'editor')").run(editorId, created.body.id)

    const asEditor = await request(app).put(`/api/profiles/${created.body.id}`)
      .set('X-Telegram-Chat-Id', '222').send({ name: 'Hackeado' })
    expect(asEditor.status).toBe(403)

    const asOwner = await request(app).put(`/api/profiles/${created.body.id}`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ identity_json: JSON.stringify({ tono: 'nosotros' }) })
    expect(asOwner.status).toBe(200)
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/profiles.test.js`
Expected: FAIL — 404 en `/api/profiles`

- [ ] **Step 3: Implementar**

`core-api/src/routes/profiles.js`:

```js
import { Router } from 'express'
import { can } from '../permissions.js'

const EDITABLE = ['name', 'identity_json', 'cadence_json', 'format_strategy_json', 'ai_overrides_json', 'visual_template']

export function profilesRouter(db) {
  const r = Router()

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.slug, p.status, a.role
      FROM brand_profiles p
      JOIN user_profile_access a ON a.profile_id = p.id
      WHERE a.user_id = ?
      ORDER BY p.id
    `).all(req.user.id)
    res.json(rows)
  })

  r.post('/', (req, res) => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'solo el administrador crea perfiles' })
    const { name, slug, identity = {} } = req.body
    if (!name || !slug) return res.status(400).json({ error: 'name y slug son requeridos' })
    const info = db.prepare(
      'INSERT INTO brand_profiles (name, slug, identity_json) VALUES (?, ?, ?)'
    ).run(name, slug, JSON.stringify(identity))
    db.prepare(
      "INSERT INTO user_profile_access (user_id, profile_id, role) VALUES (?, ?, 'owner')"
    ).run(req.user.id, info.lastInsertRowid)
    res.status(201).json({ id: info.lastInsertRowid })
  })

  r.get('/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'ver_perfil')) return res.status(403).json({ error: 'sin acceso al perfil' })
    const p = db.prepare('SELECT * FROM brand_profiles WHERE id = ?').get(id)
    if (!p) return res.status(404).json({ error: 'perfil inexistente' })
    res.json(p)
  })

  r.put('/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'editar_perfil')) return res.status(403).json({ error: 'solo owner edita el perfil' })
    const sets = []
    const vals = []
    for (const field of EDITABLE) {
      if (field in req.body) { sets.push(`${field} = ?`); vals.push(req.body[field]) }
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' })
    vals.push(id)
    db.prepare(`UPDATE brand_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  })

  return r
}
```

Modificar `core-api/src/app.js` — agregar el import y el montaje dentro del bloque `if (db)`:

```js
import express from 'express'
import { authMiddleware } from './auth.js'
import { profilesRouter } from './routes/profiles.js'

export function createApp(db) {
  const app = express()
  app.use(express.json({ limit: '50mb' })) // evidencia entra como base64
  app.get('/health', (_req, res) => res.json({ ok: true }))

  if (db) {
    const api = express.Router()
    api.use(authMiddleware(db))
    api.get('/me', (req, res) => {
      const { id, name, is_admin } = req.user
      res.json({ id, name, is_admin })
    })
    api.use('/profiles', profilesRouter(db))
    app.use('/api', api)
    app.locals.api = api // los routers de rutas se montan acá en tasks siguientes
  }

  app.locals.db = db
  return app
}
```

- [ ] **Step 4: Verificar que pasa (toda la suite)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites en verde

- [ ] **Step 5: Commit**

```bash
git add core-api/src/routes/profiles.js core-api/src/app.js core-api/tests/profiles.test.js
git commit -m "feat(core-api): perfiles de marca con aislamiento estricto por usuario"
```

---

### Task 8: Canales del perfil con credenciales cifradas

**Files:**
- Modify: `core-api/src/routes/profiles.js`
- Test: `core-api/tests/profile-channels.test.js`

**Interfaces:**
- Consumes: `encryptJson`/`decryptJson` (Task 4), `can` (Task 6), catálogo `channels` (Task 3).
- Produces:
  - `POST /api/profiles/:id/channels {channel_code, handle?, credentials?, token_expires_at?}` → 201; upsert por (perfil, canal); cifra `credentials`; estado pasa a `conectado` si hay credenciales
  - `GET /api/profiles/:id/channels` → lista SIN credenciales en claro (`has_credentials` booleano). El Plan D leerá los tokens con `decryptJson` desde los publicadores.

- [ ] **Step 1: Escribir el test que falla**

`core-api/tests/profile-channels.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'
import { decryptJson } from '../src/crypto.js'

async function withProfile(app) {
  const res = await request(app).post('/api/profiles')
    .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    .send({ name: 'Juan Pablo', slug: 'juanpablo' })
  return res.body.id
}

describe('canales del perfil', () => {
  it('conecta un canal cifrando credenciales', async () => {
    const { app, db } = makeTestApp()
    const profileId = await withProfile(app)
    const res = await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ channel_code: 'linkedin', handle: 'juanpablosarobe', credentials: { access_token: 'tok-li-1' } })
    expect(res.status).toBe(201)

    const row = db.prepare(`
      SELECT pc.* FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ? AND c.code = 'linkedin'
    `).get(profileId)
    expect(row.status).toBe('conectado')
    expect(row.credentials_enc).not.toContain('tok-li-1')       // cifrado en reposo
    expect(decryptJson(row.credentials_enc)).toEqual({ access_token: 'tok-li-1' })
  })

  it('la lista jamás devuelve credenciales', async () => {
    const { app } = makeTestApp()
    const profileId = await withProfile(app)
    await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ channel_code: 'linkedin', credentials: { access_token: 'tok' } })
    const res = await request(app).get(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
    expect(res.status).toBe(200)
    expect(res.body[0].has_credentials).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('tok')
    expect(res.body[0].credentials_enc).toBeUndefined()
  })

  it('editor no gestiona canales (solo owner)', async () => {
    const { app, db } = makeTestApp()
    const profileId = await withProfile(app)
    addUser(db, '222')
    const editorId = db.prepare("SELECT id FROM users WHERE telegram_chat_id='222'").get().id
    db.prepare("INSERT INTO user_profile_access VALUES (?, ?, 'editor')").run(editorId, profileId)
    const res = await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', '222')
      .send({ channel_code: 'linkedin', credentials: { access_token: 'x' } })
    expect(res.status).toBe(403)
  })

  it('rechaza canal inexistente en el catálogo', async () => {
    const { app } = makeTestApp()
    const profileId = await withProfile(app)
    const res = await request(app).post(`/api/profiles/${profileId}/channels`)
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ channel_code: 'myspace' })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/profile-channels.test.js`
Expected: FAIL — 404 en `/api/profiles/:id/channels`

- [ ] **Step 3: Implementar**

Agregar a `core-api/src/routes/profiles.js` — nuevo import arriba y dos rutas antes del `return r`:

```js
import { encryptJson } from '../crypto.js'
```

```js
  r.post('/:id/channels', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'gestionar_canales')) {
      return res.status(403).json({ error: 'solo owner gestiona canales' })
    }
    const { channel_code, handle = null, credentials = null, token_expires_at = null } = req.body
    const channel = db.prepare('SELECT id FROM channels WHERE code = ?').get(channel_code)
    if (!channel) return res.status(400).json({ error: `canal desconocido: ${channel_code}` })

    const enc = credentials ? encryptJson(credentials) : null
    const status = credentials ? 'conectado' : 'desconectado'
    db.prepare(`
      INSERT INTO profile_channels (profile_id, channel_id, handle, credentials_enc, status, token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile_id, channel_id) DO UPDATE SET
        handle = excluded.handle,
        credentials_enc = COALESCE(excluded.credentials_enc, credentials_enc),
        status = excluded.status,
        token_expires_at = excluded.token_expires_at
    `).run(id, channel.id, handle, enc, status, token_expires_at)
    res.status(201).json({ ok: true })
  })

  r.get('/:id/channels', (req, res) => {
    const id = Number(req.params.id)
    if (!can(db, req.user.id, id, 'ver_perfil')) return res.status(403).json({ error: 'sin acceso al perfil' })
    const rows = db.prepare(`
      SELECT c.code AS channel_code, c.name AS channel_name, pc.handle, pc.status,
             pc.token_expires_at, (pc.credentials_enc IS NOT NULL) AS has_credentials
      FROM profile_channels pc
      JOIN channels c ON c.id = pc.channel_id
      WHERE pc.profile_id = ?
    `).all(id)
    res.json(rows.map(row => ({ ...row, has_credentials: !!row.has_credentials })))
  })
```

- [ ] **Step 4: Verificar que pasa (toda la suite)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites en verde

- [ ] **Step 5: Commit**

```bash
git add core-api/src/routes/profiles.js core-api/tests/profile-channels.test.js
git commit -m "feat(core-api): canales por perfil con credenciales cifradas en reposo"
```

---

### Task 9: Archivo de evidencia

**Files:**
- Create: `core-api/src/routes/evidence.js`
- Modify: `core-api/src/app.js`
- Test: `core-api/tests/evidence.test.js`

**Interfaces:**
- Consumes: `authMiddleware` (Task 5).
- Produces: `evidenceRouter(db)` montado en `/api/evidence`:
  - `POST /api/evidence {type, text?, filename?, content_base64?, context?}` → 201 `{id, folio}` (folio `E-0001`); guarda el binario en `MEDIA_DIR` (default `/data/media`)
  - `GET /api/evidence` → solo la evidencia del usuario autenticado, más reciente primero
  El Plan B agrega acá transcripción/visión; el Plan C la consume para ideas.

- [ ] **Step 1: Escribir el test que falla**

`core-api/tests/evidence.test.js`:

```js
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { existsSync, readFileSync } from 'node:fs'
import { makeTestApp, ADMIN_CHAT, addUser } from './helpers.js'

describe('evidencia', () => {
  it('guarda texto y devuelve folio legible', async () => {
    const { app } = makeTestApp()
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'probamos el sensor nuevo, funcionó de una' })
    expect(res.status).toBe(201)
    expect(res.body.folio).toBe('E-0001')
  })

  it('guarda un binario en MEDIA_DIR y la ruta en la DB', async () => {
    const { app, db } = makeTestApp()
    const contenido = Buffer.from('foto-fake')
    const res = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'foto', filename: 'prueba.jpg', content_base64: contenido.toString('base64') })
    expect(res.status).toBe(201)
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(res.body.id)
    expect(existsSync(row.file_path)).toBe(true)
    expect(readFileSync(row.file_path)).toEqual(contenido)
  })

  it('rechaza tipo inválido y foto sin contenido', async () => {
    const { app } = makeTestApp()
    const invalido = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT).send({ type: 'olor' })
    expect(invalido.status).toBe(400)
    const sinContenido = await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT).send({ type: 'foto' })
    expect(sinContenido.status).toBe(400)
  })

  it('AISLAMIENTO: cada usuario ve solo su evidencia', async () => {
    const { app, db } = makeTestApp()
    await request(app).post('/api/evidence')
      .set('X-Telegram-Chat-Id', ADMIN_CHAT)
      .send({ type: 'texto', text: 'evidencia del admin' })
    addUser(db, '222')
    const res = await request(app).get('/api/evidence').set('X-Telegram-Chat-Id', '222')
    expect(res.body).toEqual([])
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `cd core-api && npx vitest run tests/evidence.test.js`
Expected: FAIL — 404 en `/api/evidence`

- [ ] **Step 3: Implementar**

`core-api/src/routes/evidence.js`:

```js
import { Router } from 'express'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const TYPES = ['foto', 'audio', 'video', 'texto', 'link']
const BINARY_TYPES = ['foto', 'audio', 'video']

export function evidenceRouter(db) {
  const r = Router()

  r.post('/', (req, res) => {
    const { type, text = null, filename = null, content_base64 = null, context = {} } = req.body
    if (!TYPES.includes(type)) return res.status(400).json({ error: `tipo inválido: ${type}` })
    if (BINARY_TYPES.includes(type) && !content_base64) {
      return res.status(400).json({ error: `${type} requiere content_base64` })
    }
    if (!BINARY_TYPES.includes(type) && !text) {
      return res.status(400).json({ error: `${type} requiere text` })
    }

    let filePath = null
    if (content_base64) {
      const dir = process.env.MEDIA_DIR || '/data/media'
      mkdirSync(dir, { recursive: true })
      const safeName = (filename || 'archivo.bin').replace(/[^\w.\-]/g, '_')
      filePath = path.join(dir, `${randomBytes(8).toString('hex')}-${safeName}`)
      writeFileSync(filePath, Buffer.from(content_base64, 'base64'))
    }

    const info = db.prepare(`
      INSERT INTO evidence (user_id, type, file_path, text_content, context_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, type, filePath, text, JSON.stringify(context))
    const id = info.lastInsertRowid
    res.status(201).json({ id, folio: `E-${String(id).padStart(4, '0')}` })
  })

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT id, type, file_path, text_content, transcription, vision_description, created_at
      FROM evidence WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(req.user.id)
    res.json(rows)
  })

  return r
}
```

Modificar `core-api/src/app.js` — agregar el import y el montaje junto al de profiles:

```js
import { evidenceRouter } from './routes/evidence.js'
```

```js
    api.use('/evidence', evidenceRouter(db))
```

- [ ] **Step 4: Verificar que pasa (toda la suite)**

Run: `cd core-api && npx vitest run`
Expected: PASS — todas las suites en verde

- [ ] **Step 5: Commit**

```bash
git add core-api/src/routes/evidence.js core-api/src/app.js core-api/tests/evidence.test.js
git commit -m "feat(core-api): archivo de evidencia con folio y aislamiento por usuario"
```

---

### Task 10: Docker Compose, .env.example y verificación end-to-end

**Files:**
- Create: `core-api/Dockerfile`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: `docker compose up -d --build` deja la core-api viva en `:3000` con volumen `pbos_data`. Los Planes B/C/D agregan servicios a este mismo compose.

- [ ] **Step 1: Escribir Dockerfile**

`core-api/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
```

- [ ] **Step 2: Escribir docker-compose y .env.example**

`docker-compose.yml`:

```yaml
services:
  core-api:
    build: ./core-api
    env_file: .env
    environment:
      - DB_PATH=/data/pbos.db
      - MEDIA_DIR=/data/media
    volumes:
      - pbos_data:/data
    ports:
      - "3000:3000"
    restart: unless-stopped

volumes:
  pbos_data:
```

`.env.example`:

```bash
# Clave maestra de cifrado de credenciales (32 bytes hex).
# Generar con: openssl rand -hex 32
MASTER_KEY=

# Bootstrap del usuario administrador (tu chat ID de Telegram).
# Se obtiene en el Plan B con el bot; por ahora cualquier número sirve para probar.
ADMIN_CHAT_ID=
ADMIN_NAME=

# --- Planes siguientes (dejar vacío por ahora) ---
# TELEGRAM_BOT_TOKEN=   (Plan B)
# GROQ_API_KEY=         (Plan B)
```

`.gitignore`:

```
node_modules/
.env
*.db
*.db-wal
*.db-shm
/data/
```

- [ ] **Step 3: Verificación end-to-end con curl**

```bash
cp .env.example .env
# editar .env: MASTER_KEY=$(openssl rand -hex 32), ADMIN_CHAT_ID=111, ADMIN_NAME="Juan Pablo"
docker compose up -d --build
sleep 3
curl -s http://localhost:3000/health
# esperado: {"ok":true}
curl -s -X POST http://localhost:3000/api/profiles \
  -H 'X-Telegram-Chat-Id: 111' -H 'Content-Type: application/json' \
  -d '{"name":"Juan Pablo","slug":"juanpablo"}'
# esperado: {"id":1}
curl -s http://localhost:3000/api/profiles -H 'X-Telegram-Chat-Id: 111'
# esperado: [{"id":1,...,"role":"owner"}]
curl -s http://localhost:3000/api/profiles -H 'X-Telegram-Chat-Id: 999'
# esperado: {"error":"usuario no autorizado"}
```

Expected: las cuatro respuestas como se indica.

- [ ] **Step 4: Actualizar README**

Reemplazar el contenido de `README.md` por:

```markdown
# Personal Brand OS 🚀

Motor configurable de marca personal: capturás evidencia (fotos, audios, textos,
links) por Telegram y el sistema la convierte en contenido profesional por marca,
publicado en tus redes.

- **Diseño:** [`docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md`](docs/superpowers/specs/2026-07-17-personal-brand-os-v1-design.md)
- **Estado:** Plan A (cimientos core-api) — ver `docs/superpowers/plans/`

## Levantar en la Mac mini

```bash
cp .env.example .env   # completar MASTER_KEY (openssl rand -hex 32) y ADMIN_CHAT_ID
docker compose up -d --build
curl http://localhost:3000/health   # → {"ok":true}
```

## Desarrollo local

```bash
cd core-api && npm install && npm test
```
```

- [ ] **Step 5: Commit final del plan**

```bash
git add core-api/Dockerfile docker-compose.yml .env.example .gitignore README.md
git commit -m "feat: docker compose para la core-api en la Mac mini"
```

---

## Self-Review del plan (ejecutada)

1. **Cobertura vs spec:** este Plan A cubre spec §4 (modelo de datos completo: 17 tablas), §4.2 (usuarios/roles/aislamiento), §7-credenciales (cifrado en reposo, dos niveles), evidencia base de §4.7, y §9 parcial (compose). Lo NO cubierto queda asignado: transcripción/visión y sesiones→Plan B; ideas/drafts/versions y agente→Plan C; publicadores/scheduler/token-health→Plan D; invitaciones/OAuth/Tailscale→Plan E; backup diario→Plan E (tarea de despliegue).
2. **Placeholders:** sin TBD/TODO; todo step con código completo y comando con salida esperada.
3. **Consistencia de tipos:** `createApp(db)`, `openDb({dbPath})`, `can(db, userId, profileId, action)`, `encryptJson/decryptJson`, `makeTestApp()/addUser()` usados con la misma firma en todas las tasks; nombres de tablas/campos idénticos entre schema.sql, rutas y tests.
