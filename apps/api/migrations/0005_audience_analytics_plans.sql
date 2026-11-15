-- Audiencia de YouTube, miniatura automática en el directo vigente, analítica del propietario y planes. Aditiva (sin borrar datos).

-- Seguimiento del directo de YouTube de cada destino (también los creados con clave manual, si el canal está conectado)
ALTER TABLE destinations ADD COLUMN yt_live_video_id TEXT;        -- emisión (vídeo) de YouTube enlazada ahora a la clave
ALTER TABLE destinations ADD COLUMN yt_checked_at INTEGER;        -- última consulta a la API de YouTube
ALTER TABLE destinations ADD COLUMN yt_thumb_video_id TEXT;       -- vídeo al que se envió la miniatura vigente
ALTER TABLE destinations ADD COLUMN yt_thumb_attempt_at INTEGER;  -- último intento (los fallos se reintentan cada hora)
ALTER TABLE destinations ADD COLUMN yt_broadcast_template TEXT;   -- título, descripción, privacidad y «para niños» para crear el siguiente directo

-- Muestras de audiencia (cada 5 min mientras la emisión está en el aire). Retención: 90 días.
CREATE TABLE stream_metrics (
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  video_id TEXT,
  viewers INTEGER,
  views INTEGER,
  likes INTEGER,
  PRIMARY KEY (stream_id, destination_id, at)
);
CREATE INDEX idx_metrics_org ON stream_metrics(organization_id, at);
CREATE INDEX idx_metrics_at ON stream_metrics(at);

-- Accesos a la plataforma (país/ciudad de Cloudflare, sin IP). Retención: 180 días.
CREATE TABLE login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  device TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_events_at ON login_events(created_at);
CREATE INDEX idx_login_events_user ON login_events(user_id, created_at DESC);

-- Visitas a la web pública, agregadas por día (sin cookies ni datos personales). Retención: 400 días.
CREATE TABLE page_views_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  country TEXT NOT NULL,
  referrer TEXT NOT NULL,
  device TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, country, referrer, device)
);

-- Planes: fecha del último cambio y solicitudes de cambio (el propietario las aprueba o enlaza el cobro)
ALTER TABLE organizations ADD COLUMN plan_updated_at INTEGER;
CREATE TABLE plan_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  billing TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_plan_requests_status ON plan_requests(status, created_at DESC);
