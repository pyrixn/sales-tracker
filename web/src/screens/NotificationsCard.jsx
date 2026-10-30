// Notifications under More: what is queued and sent, the last errors, the channel switches and Send now.
// Shows whether each channel has its secret (set in Supabase, never in the panel); the secrets themselves never reach the panel.
import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { notify } from '@/lib/store';
import { Row, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

const CHANNELS = [
  ['whatsapp', 'WhatsApp', 'Customer reminders, sent as approved templates', 'WHATSAPP_TOKEN and WHATSAPP_PHONE_ID'],
  ['discord', 'Discord', 'Owner alerts: website orders, payments to match, failed jobs', 'DISCORD_WEBHOOK_URL'],
  ['telegram', 'Telegram', 'Owner alerts to your phone', 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID']
];
const KINDS = [['before', 'Before renewal'], ['on_day', 'Renewal day'], ['after', 'After it ends'], ['due', 'Balance due']];
const COUNTS = [['pending', 'Waiting'], ['sending', 'Sending'], ['sent', 'Sent'], ['failed', 'Failed']];

export function NotificationsCard() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    const r = await call('notifyStatus');
    if (r.ok) { setSt(r.data); setErr(''); } else setErr(r.error);
  }
  useEffect(() => { load(); }, []);

  async function sendNow() {
    setBusy(true);
    const r = await call('sendNotifications', { requestId: rid() });
    setBusy(false);
    if (!r.ok) return notify(r.error);
    const d = r.data;
    notify('Queued ' + d.queued + ' · sent ' + d.sent + ' · retry later ' + d.retry + ' · failed ' + d.failed);
    load();
  }

  async function toggle(ch, on) {
    const key = 'notify_' + ch + '_enabled';
    const r = await call('settings', { values: { [key]: on ? 'true' : 'false' }, requestId: rid() });
    notify(r.ok ? (CHANNELS.find(c => c[0] === ch)[1] + (on ? ' on' : ' off')) : r.error);
    load();
  }

  if (!st) {
    return (
      <Section title="Notifications" icon={BellRing} testId="notifications-card">
        <Row title={err || 'Loading notifications'} detail={err ? 'Try again in a moment.' : ''} />
      </Section>
    );
  }

  const tplText = KINDS.map(([k, label]) => label + ': ' + (st.templates[k] || 'not sent')).join(' · ');
  return (
    <Section title="Notifications" icon={BellRing} testId="notifications-card">
      <div className="grid grid-cols-4 gap-2 px-4 py-3 text-center" data-testid="notify-counts">
        {COUNTS.map(([k, label]) => (
          <div key={k}>
            <div className="font-mono text-lg font-bold" data-count={k}>{st.counts[k]}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      {CHANNELS.map(([ch, name, what, secret]) => {
        const c = st.channels[ch];
        const detail = (what) + '. ' + (c.configured ? (c.switchOn ? 'On' : 'Off') : 'Not configured: add ' + secret + ' in Supabase secrets');
        return (
          <Row key={ch} title={name} detail={detail} wrap
            trail={<Switch id={'notify-' + ch} aria-label={'Send ' + name + ' messages'} checked={c.switchOn} onCheckedChange={on => toggle(ch, on)} />} />
        );
      })}
      <div className="px-4 py-3 text-xs text-muted-foreground break-words">{'WhatsApp templates: ' + tplText}</div>
      {st.errors.length ? (
        <ul className="px-4 pb-3 text-xs" data-testid="notify-errors">
          {st.errors.map((e, i) => (
            <li key={i} className="py-1 text-destructive">{e.channel + ' · ' + e.status + ' · ' + e.attempts + ' tries · ' + e.error}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-3 px-4 py-3">
        <Button type="button" variant="outline" onClick={sendNow} disabled={busy}>Send now</Button>
        <span className="text-xs text-muted-foreground">{st.lastSentAt ? 'Last sent ' + st.lastSentAt.slice(0, 16).replace('T', ' ') : 'Nothing sent yet'}</span>
      </div>
    </Section>
  );
}
