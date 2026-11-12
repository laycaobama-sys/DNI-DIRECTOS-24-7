-- Esquema inicial (Cloudflare D1 / SQLite). Timestamps en milisegundos UTC.
-- Todo recurso de tenant lleva organization_id y toda consulta de la API filtra por él.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at INTEGER,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'es',
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  suspended_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','operator','viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX idx_members_user ON organization_members(user_id);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('video','audio','image')),
  status TEXT NOT NULL CHECK (status IN ('uploading','queued','processing','ready','failed')),
  size_bytes INTEGER NOT NULL,
  content_type TEXT,
  sha256 TEXT,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  duration_sec REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  video_codec TEXT,
  audio_codec TEXT,
  has_audio INTEGER,
  progress INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_media_org ON media_assets(organization_id, created_at DESC);
CREATE INDEX idx_media_queue ON media_assets(status, lease_expires_at);

CREATE TABLE media_upload_parts (
  media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (media_id, part_number)
);

CREATE TABLE media_variants (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('canonical','thumbnail')),
  profile TEXT,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_variants_media ON media_variants(media_id, kind, profile);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Borrador editable: JSON [{mediaId}]
  draft_items TEXT NOT NULL DEFAULT '[]',
  published_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_playlists_org ON playlists(organization_id, created_at DESC);

-- Versiones inmutables: lo que emite el motor siempre es una versión publicada.
CREATE TABLE playlist_versions (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  items TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (playlist_id, version)
);

CREATE TABLE destinations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'custom',
  url TEXT NOT NULL,
  secure INTEGER NOT NULL,
  -- Clave de emisión cifrada AES-256-GCM (iv.ciphertext en base64url). Nunca se devuelve completa.
  stream_key_enc TEXT NOT NULL,
  stream_key_last4 TEXT NOT NULL,
  key_rotated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_destinations_org ON destinations(organization_id);

CREATE TABLE streams (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  playlist_id TEXT NOT NULL REFERENCES playlists(id),
  mode TEXT NOT NULL DEFAULT 'loop' CHECK (mode IN ('loop','once','shuffle')),
  profile TEXT NOT NULL DEFAULT '720p30',
  seed INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ready',
  status_reason TEXT,
  desired_state TEXT NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running','stopped')),
  restart_nonce INTEGER NOT NULL DEFAULT 0,
  -- Lease + fencing: solo el nodo con el fencing_token vigente puede informar o emitir.
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  current_session_id TEXT,
  -- Última posición informada (para reanudación aproximada): JSON {cycle, position, playlistVersionId, mediaId}
  position TEXT,
  metrics TEXT,
  last_heartbeat_at INTEGER,
  started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_streams_org ON streams(organization_id, created_at DESC);
CREATE INDEX idx_streams_claim ON streams(desired_state, lease_expires_at);

CREATE TABLE stream_destinations (
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  bitrate_kbps REAL,
  out_time_sec REAL,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER,
  PRIMARY KEY (stream_id, destination_id)
);

CREATE TABLE stream_sessions (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  -- Segundos emitidos medidos por heartbeats del motor (base de usage metering).
  live_seconds INTEGER NOT NULL DEFAULT 0,
  bytes_sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_stream ON stream_sessions(stream_id, started_at DESC);
CREATE INDEX idx_sessions_org ON stream_sessions(organization_id, started_at DESC);

CREATE TABLE stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_stream ON stream_events(stream_id, id DESC);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  time_zone TEXT NOT NULL,
  time TEXT NOT NULL,
  recurrence TEXT NOT NULL,
  duration_minutes INTEGER,
  next_start_at INTEGER,
  next_stop_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_start_at);

CREATE TABLE worker_nodes (
  id TEXT PRIMARY KEY,
  hostname TEXT,
  version TEXT,
  capacity INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_org ON audit_logs(organization_id, id DESC);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
