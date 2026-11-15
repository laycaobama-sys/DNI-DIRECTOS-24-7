-- Grabación en la nube, vista previa en directo y miniaturas personalizadas. Migración aditiva (sin borrar datos).

-- Configuración por emisión
ALTER TABLE streams ADD COLUMN recording_mode TEXT NOT NULL DEFAULT 'off';          -- off | auto
ALTER TABLE streams ADD COLUMN recording_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE streams ADD COLUMN preview_until INTEGER;                               -- la vista previa solo se genera mientras alguien la mira
ALTER TABLE streams ADD COLUMN preview_index TEXT;                                 -- últimos fragmentos de la vista previa (JSON)
ALTER TABLE streams ADD COLUMN thumbnail_key TEXT;
ALTER TABLE streams ADD COLUMN thumbnail_updated_at INTEGER;
ALTER TABLE playlists ADD COLUMN thumbnail_key TEXT;
ALTER TABLE playlists ADD COLUMN thumbnail_updated_at INTEGER;
-- Miniatura personalizada de un vídeo (si no hay, se usa la generada automáticamente)
ALTER TABLE media_assets ADD COLUMN custom_thumbnail_key TEXT;

-- Una grabación = una sesión de emisión grabada, troceada en fragmentos independientes (un fallo no pierde el resto)
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stream_id TEXT REFERENCES streams(id) ON DELETE SET NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','ready','exporting','failed','deleted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_sec REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  thumbnail_key TEXT,
  export_key TEXT,
  export_status TEXT CHECK (export_status IN ('pending','processing','ready','failed')),
  export_error TEXT,
  export_attempts INTEGER NOT NULL DEFAULT 0,
  export_lease_expires_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recordings_org ON recordings(organization_id, started_at DESC);
CREATE INDEX idx_recordings_session ON recordings(session_id);
CREATE INDEX idx_recordings_expire ON recordings(expires_at);
CREATE INDEX idx_recordings_stream ON recordings(stream_id, started_at DESC);

CREATE TABLE recording_segments (
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','failed')),
  start_offset_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  -- 1 = primer fragmento tras un relevo de nodo (salto de marcas de tiempo): el reproductor debe resincronizar
  discontinuity INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, seq)
);

CREATE TABLE recording_segment_parts (
  recording_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (recording_id, seq, part_number)
);

-- Sincronización de miniaturas con YouTube (resultado por destino)
ALTER TABLE destinations ADD COLUMN youtube_thumbnail_synced_at INTEGER;
ALTER TABLE destinations ADD COLUMN youtube_thumbnail_error TEXT;
