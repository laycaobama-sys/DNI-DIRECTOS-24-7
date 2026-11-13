import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, ShieldCheck, User } from 'lucide-react';
import { api, fmtTime } from '../api';
import { GoogleIcon } from '../brand';
import { useMe, useTitle } from '../hooks';
import { Badge, Button, Card, ConfirmButton, Field, Input, PageHeader, Skeleton, errMsg, toast } from '../ui';

export default function SettingsPage() {
  useTitle('Ajustes');
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  if (!me.data) return <Skeleton className="h-96" />;
  const { user, organizations, current } = me.data;
  const org = organizations.find((o) => o.id === current.id);

  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setSavingProfile(true);
    try { await api('PATCH', '/v1/auth/me', f); await qc.invalidateQueries({ queryKey: ['me'] }); toast('Perfil actualizado'); } catch (err) { toast(errMsg(err), 'error'); } finally { setSavingProfile(false); }
  }
  async function savePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (f.password !== f.confirm) { toast('Las contraseñas no coinciden.', 'error'); return; }
    setSavingPw(true);
    try {
      await api('POST', '/v1/auth/password', { current: f.current || undefined, password: f.password });
      form.reset(); await qc.invalidateQueries({ queryKey: ['me'] });
      toast(user.hasPassword ? 'Contraseña cambiada. Se cerró la sesión en tus otros dispositivos.' : 'Contraseña creada. Ya puedes entrar también con tu correo.');
    } catch (err) { toast(errMsg(err), 'error'); } finally { setSavingPw(false); }
  }

  return (
    <>
      <PageHeader title="Ajustes" description="Tu perfil, el acceso a tu cuenta y la seguridad." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="flex items-center gap-2 font-semibold"><User className="size-4 text-air-500" />Perfil</h2>
          <form onSubmit={saveProfile} className="mt-5 space-y-4">
            <Field label="Nombre">{(id) => <Input id={id} name="name" defaultValue={user.name} required maxLength={80} />}</Field>
            <Field label="Nombre del canal o la organización" hint={current.role === 'owner' || current.role === 'admin' ? undefined : 'Solo los administradores pueden cambiarlo.'}>
              {(id) => <Input id={id} name="organizationName" defaultValue={org?.name} required maxLength={80} disabled={!(current.role === 'owner' || current.role === 'admin')} />}
            </Field>
            <Field label="Email">{(id) => <Input id={id} value={user.email} disabled readOnly />}</Field>
            <Button variant="primary" type="submit" loading={savingProfile}>Guardar perfil</Button>
          </form>
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-air-500" />Formas de acceso</h2>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3 dark:bg-white/[0.03]"><span className="flex items-center gap-2"><GoogleIcon />Google</span>{user.google ? <Badge tone="ok">Vinculada</Badge> : <Badge>Sin vincular</Badge>}</li>
              <li className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3 dark:bg-white/[0.03]"><span className="flex items-center gap-2"><KeyRound className="size-4" />Correo y contraseña</span>{user.hasPassword ? <Badge tone="ok">Activa</Badge> : <Badge>Sin contraseña</Badge>}</li>
            </ul>
            {!user.google && <p className="mt-3 text-xs text-ink-500">Para vincular Google, cierra sesión y pulsa «Continuar con Google» con una cuenta del mismo correo.</p>}
            <p className="mt-3 text-xs text-ink-500">Cuenta creada el {fmtTime(user.createdAt)}.</p>
          </Card>

          <Card>
            <h2 className="flex items-center gap-2 font-semibold"><KeyRound className="size-4 text-air-500" />{user.hasPassword ? 'Cambiar contraseña' : 'Crear una contraseña'}</h2>
            <form onSubmit={savePassword} className="mt-5 space-y-4">
              {user.hasPassword && <Field label="Contraseña actual">{(id) => <Input id={id} name="current" type="password" required autoComplete="current-password" />}</Field>}
              <Field label="Nueva contraseña" hint="Mínimo 10 caracteres.">{(id) => <Input id={id} name="password" type="password" required minLength={10} autoComplete="new-password" />}</Field>
              <Field label="Repite la contraseña">{(id) => <Input id={id} name="confirm" type="password" required minLength={10} autoComplete="new-password" />}</Field>
              <Button variant="primary" type="submit" loading={savingPw}>{user.hasPassword ? 'Cambiar contraseña' : 'Crear contraseña'}</Button>
            </form>
          </Card>

          <Card>
            <h2 className="flex items-center gap-2 font-semibold"><LogOut className="size-4 text-air-500" />Sesiones</h2>
            <p className="mt-2 text-sm text-ink-500">Cierra la sesión en todos los dispositivos donde hayas entrado, incluido este.</p>
            <div className="mt-4">
              <ConfirmButton label="Cerrar sesión en todas partes" title="Cerrar todas las sesiones" confirmLabel="Cerrar todas" variant="danger"
                message="Tendrás que volver a iniciar sesión en todos tus dispositivos. Tus emisiones en directo no se detienen."
                onConfirm={async () => { await api('POST', '/v1/auth/sessions/revoke'); qc.clear(); nav('/login'); }} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
