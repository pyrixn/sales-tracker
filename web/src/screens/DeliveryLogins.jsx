import { useCallback, useEffect, useState } from 'react';
import { Copy, MessageSquare, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { notify, useApp } from '@/lib/store';
import { Empty, ErrorBox, Field, Hint, Section, WarnBox } from '@/components/kit';
import { LoginDetails, pinProps } from '@/components/LoginDetails';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

// Delivery & logins (More, owner and staff). Logins: per account, through the same encrypted vault dialog. Templates: the owner's
// message text with placeholders. A delivery message is made on demand, behind the vault PIN: nothing it returns is stored.

const FIELDS = ['name', 'product', 'profile', 'paidTill', 'login'];
const SAMPLE = 'Your {{product}} login:\n{{login}}\nProfile: {{profile}}\nValid till {{paidTill}}';

/** "Delivery message" on a line: pick a template, enter the PIN, get the text to copy or share. The text is kept in this dialog only. */
export function DeliveryMessage({ saleId, productId = '', accountId = '', size = 'sm', variant = 'ghost', label = 'Delivery message', className }) {
  const { role } = useApp();
  const [open, setOpen] = useState(false);
  if (role === 'viewer') return null;
  return (
    <>
      <Button type="button" size={size} variant={variant} className={className} aria-label={label} onClick={e => { e.stopPropagation(); setOpen(true); }}><Send />{size === 'icon-sm' ? '' : label}</Button>
      {open ? <MessageDialog saleId={saleId} productId={productId} accountId={accountId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function MessageDialog({ saleId, productId, accountId, onClose }) {
  const [list, setList] = useState(null);
  const [pick, setPick] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  useEffect(() => {
    call('deliveryTemplates', {}).then(r => {
      if (!r.ok) { setError(r.error || 'Could not load.'); return; }
      const fit = r.data.templates.filter(t => (!t.productId || t.productId === productId) && (!t.accountId || t.accountId === accountId))
        .sort((a, b) => (b.accountId ? 2 : 0) + (b.productId ? 1 : 0) - ((a.accountId ? 2 : 0) + (a.productId ? 1 : 0)));
      setList(fit); setPick(fit[0] ? fit[0].templateId : '');
    });
  }, [productId, accountId]);
  useEffect(() => {
    if (!text) return undefined;
    const t = setTimeout(() => setText(''), 60000);
    return () => clearTimeout(t);
  }, [text]);
  async function make() {
    if (busy) return;
    setBusy(true); setError('');
    const r = await call('deliveryMessage', { saleId, templateId: pick, pin });
    setBusy(false); setPin('');
    if (!r.ok) { setError(r.error || 'Could not make the message.'); return; }
    setText(r.data.text);
  }
  async function copy() { try { await navigator.clipboard.writeText(text); notify('Copied'); } catch (e) { notify('Could not copy. Select the text and copy it.'); } }
  return (
    <Dialog open onOpenChange={o => { if (!o) { setText(''); onClose(); } }}>
      <DialogContent data-testid="delivery-dialog" aria-describedby="dm-desc">
        <DialogHeader>
          <DialogTitle>Delivery message</DialogTitle>
          <DialogDescription id="dm-desc">Fills your template for this sale. Needs the vault PIN.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {!list && !error ? <Spinner /> : null}
          {list && !list.length ? <Hint>No template fits this sale yet. The owner adds them under More, Delivery and logins.</Hint> : null}
          {list && list.length && !text ? (
            <form className="grid gap-3" onSubmit={e => { e.preventDefault(); make(); }}>
              <Field label="Template" id="dm-tpl"><NativeSelect id="dm-tpl" className="h-11" value={pick} onChange={e => setPick(e.target.value)}>
                {list.map(t => <NativeSelectOption key={t.templateId} value={t.templateId}>{t.title}</NativeSelectOption>)}</NativeSelect></Field>
              <Field label="Vault PIN" id="dm-pin"><Input id="dm-pin" {...pinProps} className="h-11" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></Field>
              <Button type="submit" className="h-11 font-bold" disabled={busy || pin.length < 4 || !pick}>{busy ? <Spinner /> : null}Make message</Button>
            </form>
          ) : null}
          {text ? (
            <div className="grid gap-3">
              <pre data-testid="delivery-text" className="max-h-64 overflow-auto rounded-lg border border-border bg-foreground/[0.04] p-3 font-mono text-sm break-words whitespace-pre-wrap">{text}</pre>
              <WarnBox>Sharing this sends the login to whoever receives it. It hides itself after 60 seconds.</WarnBox>
              <div className="flex flex-wrap gap-2">
                <Button type="button" className="h-11 px-4 font-bold" onClick={copy}><Copy />Copy</Button>
                <Button type="button" variant="outline" className="h-11 px-4 font-bold" asChild>
                  <a href={'https://wa.me/?text=' + encodeURIComponent(text)} target="_blank" rel="noopener noreferrer"><MessageSquare />Share on WhatsApp</a>
                </Button>
              </div>
            </div>
          ) : null}
          <ErrorBox>{error}</ErrorBox>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateForm({ t, products, accounts, onDone }) {
  const [f, setF] = useState(() => t || { templateId: '', title: '', body: SAMPLE, productId: '', accountId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reqId] = useState(() => rid());
  async function save() {
    setBusy(true); setError('');
    const r = await call('deliveryTemplateSave', { templateId: f.templateId || undefined, requestId: reqId, title: f.title, body: f.body, productId: f.productId, accountId: f.accountId });
    setBusy(false);
    if (!r.ok) { setError(r.error || 'Could not save.'); return; }
    notify('Template saved');
    onDone();
  }
  return (
    <form className="grid gap-3" onSubmit={e => { e.preventDefault(); save(); }}>
      <Field label="Title" id="tpl-title"><Input id="tpl-title" className="h-11" maxLength={100} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Product (blank: any)" id="tpl-prod"><NativeSelect id="tpl-prod" className="h-11" value={f.productId} onChange={e => setF({ ...f, productId: e.target.value })}>
        <NativeSelectOption value="">Any product</NativeSelectOption>{products.map(p => <NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}</NativeSelect></Field>
      <Field label="Account (blank: any)" id="tpl-acc"><NativeSelect id="tpl-acc" className="h-11" value={f.accountId} onChange={e => setF({ ...f, accountId: e.target.value })}>
        <NativeSelectOption value="">Any account</NativeSelectOption>{accounts.map(a => <NativeSelectOption key={a.id} value={a.id}>{a.id + ' · ' + a.label}</NativeSelectOption>)}</NativeSelect></Field>
      <Field label="Message" id="tpl-body" hint={'Placeholders: ' + FIELDS.map(x => '{{' + x + '}}').join(' ') + '. {{login}} is filled from the vault when the message is made. Never type a login here.'}>
        <Textarea id="tpl-body" rows={6} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></Field>
      <ErrorBox>{error}</ErrorBox>
      <div className="flex gap-2"><Button type="submit" className="h-11 px-5 font-bold" disabled={busy || !f.title.trim() || !f.body.trim()}>{busy ? <Spinner /> : null}Save template</Button>
        <Button type="button" variant="outline" className="h-11 px-5 font-bold" onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

export function DeliveryLogins() {
  const { lookups, role } = useApp();
  const owner = role === 'owner';
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);   // null | 'new' | template
  const load = useCallback(async () => { const r = await call('deliveryTemplates', {}); if (r.ok) setTemplates(r.data.templates); else setError(r.error || 'Could not load.'); }, []);
  useEffect(() => { load(); }, [load]);
  const products = (lookups && lookups.products) || [];
  const accounts = (lookups && lookups.accounts) || [];
  async function remove(t) {
    const r = await call('deliveryTemplateDelete', { templateId: t.templateId });
    if (!r.ok) { setError(r.error || 'Could not delete.'); return; }
    notify('Template deleted'); load();
  }
  const nameOf = (list, id) => { const x = list.find(y => y.id === id); return x ? x.name || x.label || id : id; };
  return (
    <div className="mx-auto grid max-w-4xl gap-4" data-testid="delivery-logins">
      <ErrorBox>{error}</ErrorBox>
      <Section title="Login details by account" count={accounts.length}>
        <div className="divide-y divide-border">
          {accounts.length ? accounts.map(a => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <div className="min-w-0 flex-1"><div className="truncate font-mono text-sm font-bold">{a.label}</div><div className="text-xs text-muted-foreground">{a.id}</div></div>
              <LoginDetails accountId={a.id} variant="outline" className="h-11 px-4 font-bold" />
            </div>
          )) : <Empty>No accounts yet.</Empty>}
        </div>
      </Section>
      <Section title="Delivery message templates" count={(templates || []).length}>
        <div className="grid gap-3 p-4">
          <Hint>{owner ? 'Write the message once per product, or per account. On a line, Delivery message fills it for that customer.' : 'The owner writes these. On a line, Delivery message fills one for that customer.'}</Hint>
          {editing ? <TemplateForm t={editing === 'new' ? null : editing} products={products} accounts={accounts} onDone={() => { setEditing(null); load(); }} /> : (
            <>
              {(templates || []).map(t => (
                <div key={t.templateId} className="grid gap-1 rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-bold">{t.title}</span>
                    <span className="text-xs text-muted-foreground">{(t.accountId || (t.productId ? nameOf(products, t.productId) : 'any'))}</span>
                    {owner ? <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={'Edit ' + t.title} onClick={() => setEditing(t)}><Pencil /></Button> : null}
                    {owner ? <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={'Delete ' + t.title} onClick={() => remove(t)}><Trash2 /></Button> : null}</div>
                  <pre className="font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{t.body}</pre>
                </div>
              ))}
              {templates && !templates.length ? <Empty>No templates yet.</Empty> : null}
              {owner ? <div><Button type="button" variant="outline" className="h-11 px-4 font-bold" onClick={() => setEditing('new')}><Plus />Add template</Button></div> : null}
            </>
          )}
        </div>
      </Section>
    </div>
  );
}
