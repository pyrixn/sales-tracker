// Public API settings under More: API keys (for the website and integrations) and webhooks (signed messages the tracker sends).
// Keys and signing secrets are shown once, when made. The panel is the owner's; there are no other panel users to limit.
import { useRef, useState } from 'react';
import { KeyRound, Send, Webhook } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { copyText } from '@/lib/reminders';
import { notify, useApp, useSheets } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { Chip, ConfirmButton, Empty, ErrorBox, Field, Hint, Pill, Row, Section, SheetShell, Stack } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const SCOPES = [['catalog:read', 'Catalog'], ['orders:write', 'Place orders'], ['orders:read', 'Read orders'], ['portal:read', 'Customer portal']];
const EVENT_LABEL = { 'order.created': 'Order created', 'order.paid': 'Order paid', 'subscription.renewed': 'Subscription renewed', 'subscription.ended': 'Subscription ended' };
const EVENT_ORDER = ['order.created', 'order.paid', 'subscription.renewed', 'subscription.ended'];
const STATUS = { delivered: ['ok', 'Delivered'], pending: ['warn', 'Queued'], failed: ['bad', 'Failed'] };

/** A one-time secret: shown in full, with a copy button, and a plain warning that it will not be shown again. */
function ShownOnce({ label, value }) {
  async function copy() {
    const ok = await copyText(value);
    notify(ok ? 'Copied' : 'Could not copy. Select the text and copy it.');
  }
  return (
    <Stack className="gap-2">
      <p className="text-sm font-semibold text-warn">{'Copy the ' + label + ' now. It is not shown again.'}</p>
      <div className="flex items-stretch gap-2">
        <code data-testid="shown-secret" className="min-w-0 flex-1 break-all rounded-md border border-border bg-foreground/[0.04] px-3 py-2 font-mono text-xs">{value}</code>
        <Button type="button" variant="outline" onClick={copy} aria-label={'Copy the ' + label}>Copy</Button>
      </div>
    </Stack>
  );
}

/** Scope or event picker: a set of toggle chips. */
function Toggles({ options, value, onChange, label }) {
  const on = v => value.indexOf(v) >= 0;
  const flip = v => onChange(on(v) ? value.filter(x => x !== v) : value.concat([v]));
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map(([v, text]) => <Chip key={v} pressed={on(v)} onClick={() => flip(v)} testId={'toggle-' + v}>{text}</Chip>)}
    </div>
  );
}

// ── API keys ──────────────────────────────────────────────────────────
export function ApiKeysSheet({ openers }) {
  const { reload } = useApp();
  const read = useRead('apiKeys');
  const keys = read.data ? read.data.keys : [];
  async function revoke(k) {
    const r = await call('revokeApiKey', { keyId: k.id, requestId: rid() });
    notify(r.ok ? r.data.message : r.error);
    if (r.ok) { read.refetch(); reload(); }
  }
  return (
    <SheetShell title="API keys" description="Keys for your website and other integrations">
      <Stack>
        <Button id="newApiKey" type="button" size="lg" className="font-extrabold" onClick={() => openers.newApiKey(read.refetch)}><KeyRound />New key</Button>
        <Hint>A key works only for the sites it lists and the scopes it was given. The key itself is shown once, when it is made.</Hint>
        {read.error ? <ErrorBox>{read.error}</ErrorBox> : null}
        <Section title="Keys" icon={KeyRound} count={keys.length}>
          {keys.length ? keys.map(k => (
            <Row key={k.id} wrap data-api-key={k.id} title={k.name + (k.active ? '' : ' (revoked)')}
              detail={(
                <>
                  <span className="block">{'Scopes: ' + (k.scopes.length ? k.scopes.join(', ') : 'none')}</span>
                  <span className="block">{'Sites: ' + (k.origins.length ? k.origins.join(', ') : 'none (server calls only)')}</span>
                  <span className="block">{'Last used: ' + (k.last_used ? new Date(k.last_used).toLocaleString() : 'never')}</span>
                </>
              )}
              trail={k.active ? (
                <ConfirmButton id={'revoke-' + k.id} label="Revoke" title={'Revoke ' + k.name + '?'}
                  description="Requests with this key stop working at once. This cannot be undone: make a new key instead."
                  confirmLabel="Revoke key" onConfirm={() => revoke(k)} />
              ) : <Pill tone="muted">Revoked</Pill>} />
          )) : <Empty>No keys yet. Make one for your website.</Empty>}
        </Section>
      </Stack>
    </SheetShell>
  );
}

/** Makes a key. The raw key appears once, in the answer; the panel then shows it and never again. */
export function NewApiKeySheet({ after }) {
  const { reload } = useApp();
  const sheets = useSheets();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(SCOPES.map(s => s[0]));
  const [origins, setOrigins] = useState('');
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useRef(false);
  const requestId = useRef(rid());

  async function save() {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    const list = origins.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const r = await call('createApiKey', { name, scopes, origins: list, requestId: requestId.current });
    guard.current = false; setBusy(false);
    if (!r.ok) { setError(r.error || 'Could not make the key.'); return; }
    setMade(r.data);
    reload();
    if (after) after();
  }

  return (
    <SheetShell title={made ? 'Key made' : 'New API key'} description="Make a key for a website or integration"
      footer={made ? <Button type="button" size="lg" className="w-full font-extrabold" onClick={() => sheets.close()}>Done</Button>
        : <Button id="saveApiKey" type="button" size="lg" className="w-full font-extrabold" disabled={busy} onClick={save}>{busy ? 'Making…' : 'Make key'}</Button>}>
      {made ? <ShownOnce label="key" value={made.key} /> : (
        <Stack>
          <Field label="Name" id="apiKeyName"><Input id="apiKeyName" placeholder="e.g. Main website" value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Scopes" id="apiKeyScopes"><Toggles label="Scopes" options={SCOPES} value={scopes} onChange={setScopes} /></Field>
          <Field label="Sites that may call it from a browser" id="apiKeyOrigins" hint="One per line, such as https://shop.example. Leave empty for server calls only.">
            <Textarea id="apiKeyOrigins" rows={3} placeholder="https://shop.example" value={origins} onChange={e => setOrigins(e.target.value)} />
          </Field>
          <ErrorBox>{error}</ErrorBox>
        </Stack>
      )}
    </SheetShell>
  );
}

// ── Webhooks ──────────────────────────────────────────────────────────
export function WebhooksSheet({ openers }) {
  const { reload } = useApp();
  const read = useRead('webhooks');
  const data = read.data || { endpoints: [], deliveries: [], events: EVENT_ORDER };

  async function sendNow() {
    const r = await call('sendWebhooks', { requestId: rid() });
    if (!r.ok) { notify(r.error); return; }
    const d = r.data;
    notify('Sent ' + d.sent + (d.retry ? ', ' + d.retry + ' to retry' : '') + (d.failed ? ', ' + d.failed + ' failed' : '') + (d.skipped ? ', ' + d.skipped + ' skipped' : '') + '.');
    read.refetch();
  }
  async function resend(d) {
    const r = await call('resendWebhook', { deliveryId: d.id, requestId: rid() });
    notify(r.ok ? r.data.message : r.error);
    if (r.ok) read.refetch();
  }
  async function toggle(ep) {
    const r = await call('saveWebhook', { id: ep.id, url: ep.url, events: ep.events, active: !ep.active, requestId: rid() });
    notify(r.ok ? (ep.active ? 'Webhook paused' : 'Webhook on') : r.error);
    if (r.ok) { read.refetch(); reload(); }
  }

  return (
    <SheetShell title="Webhooks" description="Signed messages the tracker sends to your site">
      <Stack>
        <Button id="newWebhook" type="button" size="lg" className="font-extrabold" onClick={() => openers.newWebhook(read.refetch)}><Webhook />Add webhook</Button>
        <Hint>Each message carries an X-Signature header: t=&lt;time&gt;,v1=&lt;HMAC-SHA256 of the time, a dot, and the body&gt;, made with the endpoint&apos;s secret. Check it before you trust the message.</Hint>
        {read.error ? <ErrorBox>{read.error}</ErrorBox> : null}
        <Section title="Endpoints" icon={Webhook} count={data.endpoints.length}>
          {data.endpoints.length ? data.endpoints.map(ep => (
            <Row key={ep.id} wrap data-webhook={ep.id} title={ep.url}
              detail={<span className="block">{ep.events.map(labelOf).join(' · ')}</span>}
              trail={(
                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={ep.active ? 'ok' : 'muted'}>{ep.active ? 'On' : 'Paused'}</Pill>
                  <Button type="button" size="sm" variant="outline" onClick={() => toggle(ep)}>{ep.active ? 'Pause' : 'Turn on'}</Button>
                </div>
              )} />
          )) : <Empty>No webhooks yet.</Empty>}
        </Section>
        <Section title="Recent deliveries" icon={Send} count={data.deliveries.length}
          action={data.deliveries.some(d => d.status === 'pending') ? <Button id="sendQueued" type="button" size="sm" onClick={sendNow}><Send />Send queued</Button> : null}>
          {data.deliveries.length ? data.deliveries.map(d => {
            const [tone, text] = STATUS[d.status] || ['muted', d.status];
            return (
              <Row key={d.id} wrap data-delivery={d.id} title={labelOf(d.event)}
                detail={(
                  <>
                    <span className="block">{d.attempts + (d.attempts === 1 ? ' try' : ' tries') + (d.last_error ? ' · ' + d.last_error : '')}</span>
                    <span className="block font-mono text-micro">{d.id}</span>
                  </>
                )}
                trail={(
                  <div className="flex shrink-0 items-center gap-2">
                    <Pill tone={tone}>{text}</Pill>
                    {d.status !== 'pending' ? <Button type="button" size="sm" variant="outline" onClick={() => resend(d)}>Resend</Button> : null}
                  </div>
                )} />
            );
          }) : <Empty>Nothing sent yet. Orders and renewals queue messages here.</Empty>}
        </Section>
      </Stack>
    </SheetShell>
  );
}

/** Adds an endpoint. Its signing secret is shown once, after it is saved. */
export function NewWebhookSheet({ after }) {
  const { reload } = useApp();
  const sheets = useSheets();
  const read = useRead('webhooks');
  const events = read.data ? read.data.events : EVENT_ORDER;
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState(['order.created', 'order.paid']);
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useRef(false);
  const requestId = useRef(rid());

  async function save() {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError('');
    const r = await call('saveWebhook', { url: url.trim(), events: chosen, active: true, requestId: requestId.current });
    guard.current = false; setBusy(false);
    if (!r.ok) { setError(r.error || 'Could not save the webhook.'); return; }
    setMade(r.data);
    reload();
    if (after) after();
  }

  return (
    <SheetShell title={made ? 'Webhook added' : 'New webhook'} description="Where the tracker sends signed messages"
      footer={made ? <Button type="button" size="lg" className="w-full font-extrabold" onClick={() => sheets.close()}>Done</Button>
        : <Button id="saveWebhook" type="button" size="lg" className="w-full font-extrabold" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save webhook'}</Button>}>
      {made ? <ShownOnce label="signing secret" value={made.secret} /> : (
        <Stack>
          <Field label="Address" id="webhookUrl" hint="https:// only (http:// for localhost)."><Input id="webhookUrl" inputMode="url" autoComplete="off" placeholder="https://shop.example/api/tracker" value={url} onChange={e => setUrl(e.target.value)} /></Field>
          <Field label="Messages" id="webhookEvents"><Toggles label="Events" options={events.map(e => [e, labelOf(e)])} value={chosen} onChange={setChosen} /></Field>
          <ErrorBox>{error}</ErrorBox>
        </Stack>
      )}
    </SheetShell>
  );
}

function labelOf(e) { return EVENT_LABEL[e] || e; }
