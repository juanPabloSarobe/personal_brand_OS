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
