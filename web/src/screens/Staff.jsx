import { useState } from 'react';
import { Mail, UserMinus, UserPlus, UserRoundCheck } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { notify, useApp } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { Empty, ErrorBox, Field, Hint, Pill, Row, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const ROLE_LABEL = { owner: 'Owner', staff: 'Staff', viewer: 'Viewer' };
const ROLE_TONE = { owner: 'ok', staff: 'muted', viewer: 'muted' };

/** Owner only (More shows the link to owners). Invite, change role, deactivate. Every change goes through the server, which checks the owner again. */
export function Staff() {
  const { invalidate, reload } = useApp();
  const read = useRead('staffList');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('staff');
  const [busy, setBusy] = useState('');

  async function send(action, payload, done) {
    setBusy(action + ':' + (payload.userId || ''));
    const r = await call(action, { ...payload, requestId: rid() });
    setBusy('');
    notify(r.ok ? (r.data && r.data.message) || 'Saved' : r.error);
    if (r.ok) {
      if (done) done();
      invalidate();
      read.refetch();
      reload();
    }
    return r;
  }

  function invite(e) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    send('staffInvite', { email, role: inviteRole }, () => setEmail(''));
  }

  if (read.loading && !read.data) return <div className="mx-auto grid max-w-3xl gap-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (read.error && !read.data) return <ErrorBox>{read.error}</ErrorBox>;

  const staff = read.data ? read.data.staff : [];
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Section title="Invite someone" icon={UserPlus}>
        <form onSubmit={invite} className="grid gap-3 p-1">
          <Field label="Email" id="inviteEmail" hint="They get an email to set a password, then sign in with it.">
            <Input id="inviteEmail" type="email" autoComplete="off" spellCheck={false} className="h-11" value={email} onChange={e => setEmail(e.target.value)} />
          </Field>
          <Field label="Role" id="inviteRole">
            <select id="inviteRole" className="h-11 rounded-md border border-border bg-background px-3 text-sm" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
              <option value="staff">Staff: sales, payments and customers</option>
              <option value="viewer">Viewer: read only</option>
            </select>
          </Field>
          <Button type="submit" className="font-bold" disabled={!email.trim() || !!busy}><Mail />Send invite</Button>
        </form>
      </Section>

      <Section title="Staff" count={staff.length}>
        {staff.length === 0 ? <Empty>No one but you yet.</Empty> : staff.map(m => (
          <Row key={m.userId} data-staff={m.userId} title={m.email || m.userId}
            detail={m.active ? 'Active' : 'Deactivated'}
            trail={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Pill tone={ROLE_TONE[m.role] || 'muted'}>{ROLE_LABEL[m.role] || m.role}</Pill>
                {m.role !== 'owner' ? (
                  <Button size="sm" variant="outline" disabled={!!busy}
                    onClick={() => send('staffUpdate', { userId: m.userId, role: m.role === 'staff' ? 'viewer' : 'staff' })}>
                    {m.role === 'staff' ? 'Make viewer' : 'Make staff'}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" disabled={!!busy}
                  onClick={() => send('staffUpdate', { userId: m.userId, active: !m.active })}>
                  {m.active ? <><UserMinus />Deactivate</> : <><UserRoundCheck />Reactivate</>}
                </Button>
              </div>
            } />
        ))}
      </Section>
      <Hint>A deactivated person keeps their login but loses panel access once their current session ends (within an hour).</Hint>
    </div>
  );
}
