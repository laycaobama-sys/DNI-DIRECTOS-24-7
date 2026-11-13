import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import { type Stream, api, fmtTime, get } from '../api';
import { useTitle } from '../hooks';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Skeleton, cx, errMsg, inputCls, toast } from '../ui';

interface ScheduleItem {
  id: string; streamId: string; timeZone: string; time: string; durationMinutes: number | null; nextStartAt: number | null; nextStopAt: number | null; enabled: boolean;
  recurrence: { type: 'once'; date: string } | { type: 'daily' } | { type: 'weekly'; weekdays: number[] };
}
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const describe = (r: ScheduleItem['recurrence']) => r.type === 'once' ? `Una vez, el ${r.date.split('-').reverse().join('/')}` : r.type === 'daily' ? 'Todos los días' : `Cada ${r.weekdays.map((d) => DAYS[d]).join(', ')}`;

export default function Schedule() {
  useTitle('Programación');
  const qc = useQueryClient();
  const q = useQuery<{ items: ScheduleItem[] }>({ queryKey: ['schedules'], queryFn: () => get('/v1/schedules'), refetchInterval: 30_000 });
  const streams = useQuery<{ items: Stream[] }>({ queryKey: ['streams'], queryFn: () => get('/v1/streams') });
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'once' | 'daily' | 'weekly'>('daily');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid', []);
  const name = (id: string) => streams.data?.items.find((s) => s.id === id)?.name ?? 'Emisión borrada';
  const create = useMutation({
    mutationFn: (b: unknown) => api('POST', '/v1/schedules', b),
    onSuccess: () => { setOpen(false); toast('Programación creada'); return qc.invalidateQueries({ queryKey: ['schedules'] }); },
    onError: (e) => toast(errMsg(e), 'error'),
  });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/v1/schedules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }) });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const recurrence = type === 'once' ? { type, date: f.date } : type === 'daily' ? { type } : { type, weekdays: days };
    create.mutate({ streamId: f.streamId, timeZone: f.timeZone, time: f.time, durationMinutes: f.duration ? Number(f.duration) : null, recurrence });
  }

  return (
    <>
      <PageHeader title="Programación" description={`Inicia y detiene emisiones automáticamente. Respeta tu zona horaria (${tz}) y los cambios de hora.`}
        actions={<Button variant="primary" onClick={() => setOpen(true)} disabled={!streams.data?.items.length}><Plus className="size-4" />Programar</Button>} />
      {q.isLoading ? <Skeleton className="h-48" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : !streams.data?.items.length ? <EmptyState icon={<CalendarClock />} title="Primero crea una emisión" action={<Link to="/app/streams/new"><Button variant="primary">Nueva emisión</Button></Link>}>La programación inicia y detiene emisiones que ya existen.</EmptyState>
        : q.data!.items.length === 0 ? <EmptyState icon={<CalendarClock />} title="Sin programaciones" action={<Button variant="primary" onClick={() => setOpen(true)}>Programar una emisión</Button>}>Por ejemplo: todos los días a las 20:00 durante 3 horas, o una sola vez en una fecha concreta.</EmptyState>
        : (
          <ul className="space-y-3">
            {q.data!.items.map((s) => (
              <li key={s.id}>
                <Card className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold">{name(s.streamId)}</p>
                    <p className="mt-1 text-sm text-ink-500">{describe(s.recurrence)} a las {s.time} ({s.timeZone}){s.durationMinutes ? ` · durante ${s.durationMinutes >= 60 ? `${Math.floor(s.durationMinutes / 60)} h ${s.durationMinutes % 60 ? `${s.durationMinutes % 60} min` : ''}` : `${s.durationMinutes} min`}` : ' · sin hora de fin'}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {s.nextStartAt ? <Badge tone="info">Próximo inicio: {fmtTime(s.nextStartAt)}</Badge> : s.nextStopAt ? <Badge tone="warn">Se detendrá: {fmtTime(s.nextStopAt)}</Badge> : <Badge>Finalizada</Badge>}
                    <ConfirmButton buttonVariant="ghost" label={<span className="sr-only">Borrar programación</span>} icon={<Trash2 className="size-4" />} title="Borrar programación" confirmLabel="Borrar"
                      message="La emisión no se borra; solo dejará de iniciarse y detenerse automáticamente." onConfirm={() => del.mutateAsync(s.id)} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

      <Modal open={open} title="Programar emisión" onClose={() => setOpen(false)}>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Emisión">{(id) => <select id={id} name="streamId" className={inputCls} required>{streams.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Repetición">
            {([['once', 'Una vez'], ['daily', 'A diario'], ['weekly', 'Semanal']] as const).map(([k, l]) => (
              <button type="button" key={k} role="radio" aria-checked={type === k} onClick={() => setType(k)}
                className={cx('rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 transition', type === k ? 'bg-ink-900 text-white ring-ink-900 dark:bg-white dark:text-ink-950 dark:ring-white' : 'ring-ink-200 dark:ring-white/10')}>{l}</button>
            ))}
          </div>
          {type === 'once' && <Field label="Fecha">{(id) => <Input id={id} name="date" type="date" required min={new Date().toISOString().slice(0, 10)} />}</Field>}
          {type === 'weekly' && (
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d, i) => (
                <button type="button" key={d} aria-pressed={days.includes(i)} onClick={() => setDays((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i].sort()))}
                  className={cx('size-11 rounded-xl text-sm font-semibold ring-1', days.includes(i) ? 'bg-signal text-white ring-transparent' : 'ring-ink-200 dark:ring-white/10')}>{d}</button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hora de inicio">{(id) => <Input id={id} name="time" type="time" required defaultValue="20:00" />}</Field>
            <Field label="Duración (min)" hint="Vacío = sin fin">{(id) => <Input id={id} name="duration" type="number" min={1} max={10080} placeholder="180" />}</Field>
          </div>
          <Field label="Zona horaria">{(id) => <Input id={id} name="timeZone" defaultValue={tz} required />}</Field>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" type="submit" loading={create.isPending} disabled={type === 'weekly' && !days.length}>Programar</Button></div>
        </form>
      </Modal>
    </>
  );
}
