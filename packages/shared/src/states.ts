/** Máquina de estados explícita de un canal de emisión (MASTER_SPEC E4). */
export const STREAM_STATUSES = [
  'draft',
  'ready',
  'scheduled',
  'starting',
  'live',
  'degraded',
  'recovering',
  'stopping',
  'stopped',
  'failed',
  'suspended',
] as const;
export type StreamStatus = (typeof STREAM_STATUSES)[number];

const T: Record<StreamStatus, readonly StreamStatus[]> = {
  draft: ['ready', 'starting', 'scheduled'],
  ready: ['starting', 'scheduled', 'draft', 'suspended'],
  scheduled: ['starting', 'ready', 'stopped', 'suspended'],
  starting: ['live', 'degraded', 'recovering', 'stopping', 'stopped', 'failed', 'suspended'],
  live: ['degraded', 'recovering', 'stopping', 'stopped', 'failed', 'suspended'],
  degraded: ['live', 'recovering', 'stopping', 'stopped', 'failed', 'suspended'],
  recovering: ['starting', 'live', 'degraded', 'stopping', 'stopped', 'failed', 'suspended'],
  stopping: ['stopped', 'failed'],
  stopped: ['starting', 'scheduled', 'ready', 'draft'],
  failed: ['starting', 'stopped', 'ready', 'draft'],
  suspended: ['ready', 'stopped'],
};

export function canTransition(from: StreamStatus, to: StreamStatus): boolean {
  return from === to || T[from].includes(to);
}

/** Estados en los que el canal consume (o intenta consumir) un nodo de emisión. */
export const ACTIVE_STATUSES: readonly StreamStatus[] = ['starting', 'live', 'degraded', 'recovering', 'stopping'];
export const isActive = (s: StreamStatus) => ACTIVE_STATUSES.includes(s);

export const DESTINATION_STATES = ['idle', 'connecting', 'live', 'retrying', 'failed'] as const;
export type DestinationState = (typeof DESTINATION_STATES)[number];

export const MEDIA_STATUSES = ['uploading', 'queued', 'processing', 'ready', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const ROLES = ['owner', 'admin', 'editor', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { viewer: 0, operator: 1, editor: 2, admin: 3, owner: 4 };
/** operator: puede iniciar/detener; editor: además crea/edita recursos; admin: gestiona destinos y equipo. */
export const hasRole = (role: Role, min: Role) => RANK[role] >= RANK[min];
