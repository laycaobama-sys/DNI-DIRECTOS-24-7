/**
 * Ajustes de la plataforma guardados en D1 y editables desde el panel del propietario.
 * Los secretos (p. ej. el secreto de cliente de Google) se guardan cifrados con ENCRYPTION_KEY.
 */
import { type Env, all, decryptSecret, encryptSecret, run } from './core';

export const SETTING_KEYS = {
  signupsOpen: 'signups_open',
  announcement: 'announcement',
  googleClientId: 'google_client_id',
  googleClientSecret: 'google_client_secret_enc',
  engineMaxNodes: 'engine_max_nodes',
} as const;

let cache: { at: number; values: Map<string, string> } | null = null;
const TTL_MS = 10_000;

async function load(env: Env): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await all<{ key: string; value: string }>(env.DB, 'SELECT key, value FROM app_settings');
  cache = { at: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])) };
  return cache.values;
}

export async function getSetting(env: Env, key: string): Promise<string | undefined> {
  return (await load(env)).get(key);
}

export async function setSetting(env: Env, key: string, value: string | null): Promise<void> {
  if (value === null) await run(env.DB, 'DELETE FROM app_settings WHERE key = ?', key);
  else await run(env.DB, 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, Date.now());
  cache = null;
}

/** Registro abierto: ajuste del panel; si no existe, la variable ALLOW_SIGNUPS. */
export async function signupsOpenSetting(env: Env): Promise<boolean> {
  const v = await getSetting(env, SETTING_KEYS.signupsOpen);
  return v === undefined ? env.ALLOW_SIGNUPS === 'true' : v === 'true';
}

/** Credenciales de Google: panel (cifradas) con prioridad sobre los secretos del Worker. */
export async function googleCredentials(env: Env): Promise<{ clientId: string; clientSecret: string } | null> {
  const id = (await getSetting(env, SETTING_KEYS.googleClientId)) ?? env.GOOGLE_CLIENT_ID;
  const enc = await getSetting(env, SETTING_KEYS.googleClientSecret);
  let secret = env.GOOGLE_CLIENT_SECRET;
  if (enc) {
    try { secret = await decryptSecret(env, enc, SETTING_KEYS.googleClientSecret); } catch { secret = undefined; }
  }
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

export async function setGoogleCredentials(env: Env, clientId: string | null, clientSecret: string | null) {
  await setSetting(env, SETTING_KEYS.googleClientId, clientId);
  await setSetting(env, SETTING_KEYS.googleClientSecret, clientSecret ? await encryptSecret(env, clientSecret, SETTING_KEYS.googleClientSecret) : null);
}

export async function engineMaxNodes(env: Env): Promise<number> {
  const v = Number(await getSetting(env, SETTING_KEYS.engineMaxNodes));
  return Math.min(10, Math.max(1, Number.isFinite(v) && v > 0 ? v : Number(env.ENGINE_MAX_NODES) || 3));
}
