import { z } from 'zod';

export const ENCODING_PROFILES = {
  '720p30': { width: 1280, height: 720, fps: 30, videoKbps: 3000, audioKbps: 128, label: '720p · 30 fps' },
  '1080p30': { width: 1920, height: 1080, fps: 30, videoKbps: 6000, audioKbps: 160, label: '1080p · 30 fps' },
} as const;
export type ProfileId = keyof typeof ENCODING_PROFILES;
export const PROFILE_IDS = Object.keys(ENCODING_PROFILES) as [ProfileId, ...ProfileId[]];

export interface Plan {
  label: string;
  /** Sin límites comerciales: la interfaz no muestra topes. Solo quedan salvaguardas técnicas. */
  unlimited: boolean;
  maxConcurrentStreams: number;
  maxDestinationsPerStream: number;
  storageBytes: number;
  maxUploadBytes: number;
  profiles: ProfileId[];
  monthlyStreamHours: number;
}
const ALL_PROFILES: ProfileId[] = ['720p30', '1080p30'];
/**
 * Plan por defecto: gratuito y sin límites comerciales. Las cifras son salvaguardas técnicas contra errores
 * (un bucle que cree miles de emisiones), no restricciones de producto. El máximo por archivo lo impone el
 * disco del nodo de emisión, que debe alojar a la vez el original y su conversión.
 */
const FREE: Plan = {
  label: 'Gratuito', unlimited: true, maxConcurrentStreams: 100, maxDestinationsPerStream: 10,
  storageBytes: 5 * 1024 ** 4, maxUploadBytes: 4 * 1024 ** 3, profiles: ALL_PROFILES, monthlyStreamHours: 1_000_000,
};
export const PLANS: Record<string, Plan> = {
  trial: FREE,
  free: FREE,
  /** Plan acotado: lo usan las pruebas de cuotas y sirve de base si en el futuro se introducen planes de pago. */
  restricted: { label: 'Limitado', unlimited: false, maxConcurrentStreams: 1, maxDestinationsPerStream: 1, storageBytes: 2 * 1024 ** 3, maxUploadBytes: 1024 ** 3, profiles: ['720p30'], monthlyStreamHours: 24 },
};
export type PlanId = string;
export const planFor = (id: string | null | undefined): Plan => (id ? PLANS[id] : undefined) ?? FREE;

export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;

const name = z.string().trim().min(1, 'El nombre es obligatorio.').max(120);

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email no válido.').max(254),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.').max(200),
  name: z.string().trim().min(1).max(80),
  organizationName: z.string().trim().min(1).max(80),
});
export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(200) });

export const uploadIntentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  contentType: z.string().max(100).optional(),
});

export const playlistCreateSchema = z.object({ name });
export const playlistUpdateSchema = z.object({
  name: name.optional(),
  items: z.array(z.object({ mediaId: z.string().min(1).max(64) })).max(500).optional(),
});

export const destinationCreateSchema = z.object({
  name,
  platform: z.enum(['custom', 'youtube', 'twitch']).default('custom'),
  url: z.string().min(8).max(512),
  streamKey: z.string().min(1).max(512),
  /** El usuario acepta explícitamente RTMP sin cifrar. */
  allowInsecure: z.boolean().default(false),
});
export const destinationUpdateSchema = z.object({
  name: name.optional(),
  url: z.string().min(8).max(512).optional(),
  streamKey: z.string().min(1).max(512).optional(),
  allowInsecure: z.boolean().optional(),
});

export const streamCreateSchema = z.object({
  name,
  playlistId: z.string().min(1).max(64),
  mode: z.enum(['loop', 'once', 'shuffle']).default('loop'),
  profile: z.enum(PROFILE_IDS).default('720p30'),
  destinationIds: z.array(z.string().min(1).max(64)).max(10).default([]),
});
export const streamUpdateSchema = streamCreateSchema.partial();

export const scheduleCreateSchema = z.object({
  streamId: z.string().min(1).max(64),
  timeZone: z.string().min(1).max(64),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:mm.'),
  durationMinutes: z.number().int().min(1).max(60 * 24 * 7).nullable().default(null),
  recurrence: z.discriminatedUnion('type', [
    z.object({ type: z.literal('once'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    z.object({ type: z.literal('daily') }),
    z.object({ type: z.literal('weekly'), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  ]),
});

/** Contrato motor ↔ API. */
export const heartbeatSchema = z.object({
  nodeId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  fencingToken: z.number().int(),
  status: z.enum(['starting', 'live', 'degraded', 'recovering', 'stopped', 'failed']),
  reason: z.string().max(500).optional(),
  position: z.object({ cycle: z.number().int().min(0), position: z.number().int().min(0), playlistVersionId: z.string(), mediaId: z.string().nullable() }).optional(),
  metrics: z.object({
    uptimeSec: z.number().min(0),
    feederBytes: z.number().min(0),
    itemsPlayed: z.number().int().min(0),
  }).optional(),
  destinations: z.array(z.object({
    id: z.string(),
    state: z.enum(['idle', 'connecting', 'live', 'retrying', 'failed']),
    bitrateKbps: z.number().nullable(),
    outTimeSec: z.number().nullable(),
    bytesSent: z.number(),
    restarts: z.number().int(),
    lastError: z.string().max(500).nullable(),
  })).max(20).optional(),
  events: z.array(z.object({
    type: z.string().max(64), level: z.enum(['info', 'warn', 'error']), message: z.string().max(500), at: z.number(),
    data: z.record(z.unknown()).optional(),
  })).max(100).optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export interface StreamAssignment {
  streamId: string;
  organizationId: string;
  sessionId: string;
  fencingToken: number;
  leaseTtlSec: number;
  mode: 'loop' | 'once' | 'shuffle';
  seed: number;
  profile: ProfileId;
  restartNonce: number;
  playlist: AssignedPlaylist;
  destinations: { id: string; url: string }[];
  configRevision: string;
  resume: { cycle: number; position: number } | null;
}
export interface AssignedPlaylist {
  versionId: string;
  items: { mediaId: string; variantId: string; durationSec: number; sizeBytes: number; title: string }[];
}
export interface HeartbeatResponse {
  command: 'continue' | 'stop';
  restartNonce: number;
  /** Cambia cuando se publica otra versión de playlist o se modifican destinos: el motor debe refrescar. */
  configRevision: string;
}

export interface StreamConfigRefresh {
  configRevision: string;
  playlist: AssignedPlaylist;
  destinations: { id: string; url: string }[];
}
export type MediaJob =
  | { type: 'ingest'; mediaId: string; filename: string; sizeBytes: number; profile: ProfileId }
  | { type: 'variant'; mediaId: string; variantId: string; filename: string; sizeBytes: number; profile: ProfileId };
export const mediaResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    kind: z.enum(['video', 'audio', 'image']),
    sha256: z.string().length(64).optional(),
    probe: z.object({
      durationSec: z.number().nullable(), width: z.number().int().nullable(), height: z.number().int().nullable(),
      fps: z.number().nullable(), videoCodec: z.string().nullable(), audioCodec: z.string().nullable(), hasAudio: z.boolean(),
    }).optional(),
    variantId: z.string().optional(),
    variantDurationSec: z.number().optional(),
  }),
  z.object({ ok: z.literal(false), code: z.string().max(64), message: z.string().max(500), retryable: z.boolean().default(false) }),
]);
export type MediaResult = z.infer<typeof mediaResultSchema>;
