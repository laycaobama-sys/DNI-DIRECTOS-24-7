-- Ajustes de la plataforma gestionables desde el panel del propietario (sin redesplegar).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN disabled_at INTEGER;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- La primera cuenta creada es la del propietario de la plataforma.
UPDATE users SET is_superadmin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1);

-- Canales de YouTube conectados con OAuth (API oficial). El refresh token se guarda cifrado.
CREATE TABLE youtube_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_title TEXT NOT NULL,
  channel_thumbnail TEXT,
  refresh_token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (organization_id, channel_id)
);

ALTER TABLE destinations ADD COLUMN youtube_account_id TEXT;
ALTER TABLE destinations ADD COLUMN youtube_stream_id TEXT;
ALTER TABLE destinations ADD COLUMN youtube_broadcast_id TEXT;
