import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { notify, useApp } from '@/lib/store';
import { ErrorBox, Field, Hint } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

// Login details handed to a customer with an account sale. The server keeps them encrypted and reveals one only for the vault PIN.
// What this file holds: labels (from vaultList) and, while a dialog is open, the text of one revealed login. That text lives in
// component state only (never React Query, never localStorage), hides after 60 seconds, and is dropped when the dialog closes.
// Hidden for a viewer. The server refuses a viewer whatever the panel shows.

const HIDE_MS = 60000;
export const pinProps = { type: 'password', inputMode: 'numeric', autoComplete: 'off', maxLength: 12, pattern: '[0-9]*' };

function PinField({ id, label = 'Vault PIN', value, onChange, autoFocus }) {
  return (
    <Field label={label} id={id}>
      <Input id={id} {...pinProps} className="h-11" value={value} autoFocus={autoFocus} onChange={e => onChange(e.target.value.replace(/\D/g, ''))} />
    </Field>
  );
}

/** The "Login details" button and its dialog. Give it an accountId, a saleId, or both (the list shows the sale's own when there is one). */
export function LoginDetails({ accountId = '', saleId = '', size = 'sm', variant = 'ghost', label = 'Login details', className }) {
  const { role } = useApp();
  const [open, setOpen] = useState(false);
  if (role === 'viewer') return null;
  return (
    <>
      <Button type="button" size={size} variant={variant} className={className} aria-label={label || 'Login details'} onClick={e => { e.stopPropagation(); setOpen(true); }}><Lock />{label}</Button>
      {open ? <VaultDialog accountId={accountId} saleId={saleId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function VaultDialog({ accountId, saleId, onClose }) {
  const { role } = useApp();
  const owner = role === 'owner';
  const [info, setInfo] = useState(null);       // { configured, pinSet, secrets }
  const [error, setError] = useState('');
  const [view, setView] = useState({ name: 'list' });   // list | ask { mode, secret } | shown { label, text } | add
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: '', text: '' });
  const [secretId] = useState(() => 'sec-' + rid().replace(/[^A-Za-z0-9]/g, '').slice(0, 24));
  const timer = useRef(null);

  const load = useCallback(async () => {
    const r = await call('vaultList', saleId ? { saleId } : { accountId });
    if (r.ok) setInfo(r.data); else setError(r.error || 'Could not load.');
  }, [accountId, saleId]);
  useEffect(() => { load(); }, [load]);

  // Auto-hide: a shown login goes back to the list after 60 seconds. Closing the dialog clears everything at once.
  useEffect(() => {
    if (view.name !== 'shown') return undefined;
    timer.current = setTimeout(() => { setView({ name: 'list' }); notify('Login details hidden'); }, HIDE_MS);
    return () => clearTimeout(timer.current);
  }, [view]);

  const back = () => { setView({ name: 'list' }); setPin(''); setError(''); setForm({ label: '', text: '' }); };
  const close = () => { setView({ name: 'list' }); setPin(''); setForm({ label: '', text: '' }); onClose(); };

  async function submitPin() {
    if (busy) return;
    setBusy(true); setError('');
    const s = view.secret;
    const r = view.mode === 'delete'
      ? await call('vaultDelete', { secretId: s.secretId, pin })
      : await call('vaultReveal', { secretId: s.secretId, pin });
    setBusy(false); setPin('');
    if (!r.ok) { setError(r.error || 'Could not open.'); return; }
    if (view.mode === 'delete') { notify('Login details deleted'); back(); load(); return; }
    setView({ name: 'shown', label: r.data.label, text: r.data.text });
  }
  async function submitAdd() {
    if (busy) return;
    setBusy(true); setError('');
    const r = await call('vaultSave', { secretId, requestId: rid(), accountId, saleId, label: form.label, text: form.text, pin });
    setBusy(false); setPin('');
    if (!r.ok) { setError(r.error || 'Could not save.'); return; }
    notify('Login details saved');
    back(); load();
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); notify('Copied'); } catch (e) { notify('Could not copy. Select the text and copy it.'); }
  }

  const noKey = info && !info.configured;
  const noPin = info && info.configured && !info.pinSet;
  return (
    <Dialog open onOpenChange={o => { if (!o) close(); }}>
      <DialogContent aria-describedby="vault-desc" data-testid="vault-dialog">
        <DialogHeader>
          <DialogTitle>{view.name === 'shown' ? view.label : view.name === 'add' ? 'Add login details' : 'Login details'}</DialogTitle>
          <DialogDescription id="vault-desc">Kept encrypted. Showing one needs the vault PIN.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {!info && !error ? <Spinner /> : null}
          {noKey ? <ErrorBox>The vault is not set up on the server (VAULT_KEY is missing).</ErrorBox> : null}
          {noPin ? <Hint>{owner ? 'Set a vault PIN first: Settings, Vault PIN.' : 'The owner has not set a vault PIN yet.'}</Hint> : null}

          {view.name === 'shown' ? (
            <div className="grid gap-3">
              <pre data-testid="vault-text" className="max-h-64 overflow-auto rounded-lg border border-border bg-foreground/[0.04] p-3 font-mono text-sm break-words whitespace-pre-wrap">{view.text}</pre>
              <Hint>Hides itself after 60 seconds.</Hint>
              <div className="flex flex-wrap gap-2">
                <Button type="button" className="h-11 px-4 font-bold" onClick={() => copy(view.text)}><Copy />Copy</Button>
                <Button type="button" variant="outline" className="h-11 px-4 font-bold" onClick={back}>Hide</Button>
              </div>
            </div>
          ) : null}

          {view.name === 'ask' ? (
            <form className="grid gap-3" onSubmit={e => { e.preventDefault(); submitPin(); }}>
              <Hint>{(view.mode === 'delete' ? 'Delete ' : 'Show ') + view.secret.label}</Hint>
              <PinField id="vault-pin" value={pin} onChange={setPin} autoFocus />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" className="h-11 px-4 font-bold" disabled={busy || pin.length < 4}>{busy ? <Spinner /> : null}{view.mode === 'delete' ? 'Delete' : 'Show'}</Button>
                <Button type="button" variant="outline" className="h-11 px-4 font-bold" onClick={back}>Cancel</Button>
              </div>
            </form>
          ) : null}

          {view.name === 'add' ? (
            <form className="grid gap-3" onSubmit={e => { e.preventDefault(); submitAdd(); }}>
              <Field label="Label" id="vault-label"><Input id="vault-label" className="h-11" value={form.label} maxLength={100} placeholder="For example Netflix login" onChange={e => setForm(f => ({ ...f, label: e.target.value }))} /></Field>
              <Field label="Login details" id="vault-text"><Textarea id="vault-text" rows={4} autoComplete="off" value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))} /></Field>
              <PinField id="vault-pin-add" value={pin} onChange={setPin} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" className="h-11 px-4 font-bold" disabled={busy || pin.length < 4 || !form.label.trim() || !form.text.trim()}>{busy ? <Spinner /> : null}Save</Button>
                <Button type="button" variant="outline" className="h-11 px-4 font-bold" onClick={back}>Cancel</Button>
              </div>
            </form>
          ) : null}

          {view.name === 'list' && info && !noKey ? (
            <div className="grid gap-2">
              {info.secrets.length ? (
                <ul className="grid gap-2" aria-label="Saved login details">
                  {info.secrets.map(s => (
                    <li key={s.secretId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                      <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-sm font-bold">{s.label}</span>
                      <Button type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" disabled={noPin}
                        onClick={() => { setError(''); setView({ name: 'ask', mode: 'reveal', secret: s }); }}>Show</Button>
                      {owner ? <Button type="button" size="icon" variant="ghost" className="size-11" aria-label={'Delete ' + s.label} disabled={noPin}
                        onClick={() => { setError(''); setView({ name: 'ask', mode: 'delete', secret: s }); }}><Trash2 /></Button> : null}
                    </li>
                  ))}
                </ul>
              ) : <Hint>No login details saved here yet.</Hint>}
              <div><Button type="button" variant="outline" className="h-11 px-4 font-bold" disabled={noPin} onClick={() => { setError(''); setView({ name: 'add' }); }}><Plus />Add login details</Button></div>
            </div>
          ) : null}
          <ErrorBox testId="vault-error">{error}</ErrorBox>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Settings, Vault PIN (owner): set the first PIN, or change it with the current one. */
export function VaultPinSection() {
  const [info, setInfo] = useState(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => { const r = await call('vaultList', {}); if (r.ok) setInfo(r.data); else setError(r.error || 'Could not load.'); }, []);
  useEffect(() => { load(); }, [load]);
  async function save() {
    if (busy) return;
    if (!/^\d{6,12}$/.test(next)) { setError('The PIN must be 6 to 12 digits.'); return; }
    if (next !== again) { setError('The two PINs differ.'); return; }
    setBusy(true); setError('');
    const r = await call('vaultSetPin', { newPin: next, currentPin: cur });
    setBusy(false);
    if (!r.ok) { setError(r.error || 'Could not save.'); return; }
    setCur(''); setNext(''); setAgain('');
    notify(r.data.message || 'PIN saved');
    load();
  }
  if (!info && !error) return <Spinner />;
  return (
    <form className="grid gap-3" onSubmit={e => { e.preventDefault(); save(); }}>
      {info && !info.configured ? <ErrorBox>The vault is not set up on the server (VAULT_KEY is missing).</ErrorBox> : null}
      <Hint>The PIN protects stored customer logins. Staff use it too to show a login. Five wrong tries in 15 minutes lock that person for 15 minutes; twenty wrong tries in an hour lock everyone for an hour.</Hint>
      {info && info.pinSet ? <PinField id="vault-cur" label="Current PIN" value={cur} onChange={setCur} /> : null}
      <PinField id="vault-new" label="New PIN (6 to 12 digits)" value={next} onChange={setNext} />
      <PinField id="vault-again" label="New PIN again" value={again} onChange={setAgain} />
      <ErrorBox>{error}</ErrorBox>
      <Button id="saveVaultPin" type="submit" size="lg" className="w-full font-extrabold" disabled={busy || !next || (info && info.pinSet && !cur)}>{busy ? <Spinner /> : null}{info && info.pinSet ? 'Change PIN' : 'Set PIN'}</Button>
    </form>
  );
}
