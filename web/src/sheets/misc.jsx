import { useState } from 'react';
import { Copy } from 'lucide-react';
import { rateText } from '@/lib/format';
import { useApp, useSaver } from '@/lib/store';
import { ErrorBox, Field, Hint, SaveButton, SheetShell, Stack, TemplateEditor } from '@/components/kit';
import { AllSettingsFields, BusinessFields, MessageTemplates, PayMethodsFields, RatesFields, RemindersFields, useFields, usePayMethodsDraft } from '@/components/settings/Fields';
import { businessDraft, businessValues, extraDraft, extraValues, payMethodsValues, ratesDraft, ratesValues, remindersDraft, remindersValues } from '@/components/settings/draft';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

export function MessageSheet({ text }) {
  return (
    <SheetShell title="Message" description="Copy this message and send it yourself">
      <Stack>
        <Field label="Select and copy this message" id="msgText">
          <Textarea id="msgText" rows={7} readOnly autoFocus defaultValue={text} onFocus={e => e.target.select()} />
        </Field>
        <Button type="button" variant="outline" onClick={() => { try { navigator.clipboard.writeText(text); toast('Message copied'); } catch (e) { toast('Select the text and copy it'); } }}>
          <Copy />Copy
        </Button>
      </Stack>
    </SheetShell>
  );
}

export function RateCalculatorSheet() {
  const { lookups } = useApp();
  const rateObj = lookups.rate;
  const rate = rateObj && rateObj.rate;
  const [usdt, setUsdt] = useState('');
  const [bdt, setBdt] = useState('');
  const fix = n => (Math.round(n * 100) / 100).toFixed(2);
  const status = !rate ? 'No rate yet. Set one in Settings.'
    : rateObj.source === 'manual' ? 'Manual rate'
      : rateObj.stale ? 'Stale: older than 5 minutes' : 'Updated within 5 minutes';
  return (
    <SheetShell title="USDT to BDT Calculator" description="Convert between USDT and taka at the current rate">
      <Stack>
        <div className="rounded-xl border border-border bg-card/80 p-4">
          <div className="eyebrow">Bybit P2P live rate</div>
          <div className={'hero-figure mt-2 text-5xl ' + (rate && !rateObj.stale ? 'text-ok' : 'text-bad')}>{rate ? rate : '—'}</div>
          <div className="money mt-2 text-xs text-muted-foreground">{rateText(rateObj)}</div>
          <div className="mt-1 text-xs text-muted-foreground">{status}</div>
        </div>
        <Field label="USDT amount" id="calcUsdt">
          <Input id="calcUsdt" inputMode="decimal" placeholder="10.00" disabled={!rate} value={usdt}
            onChange={e => { const x = e.target.value; setUsdt(x); const n = Number(x) || 0; setBdt(n > 0 ? fix(n * rate) : ''); }} />
        </Field>
        <Field label="BDT equivalent" id="calcBdt">
          <Input id="calcBdt" inputMode="decimal" placeholder="1235.00" disabled={!rate} value={bdt}
            onChange={e => { const x = e.target.value; setBdt(x); const n = Number(x) || 0; setUsdt(n > 0 ? fix(n / rate) : ''); }} />
        </Field>
        <Hint>Enter USDT to see BDT, or BDT to see USDT at the current exchange rate.</Hint>
      </Stack>
    </SheetShell>
  );
}

/** Message templates for one product: a single editor per kind, no language (it is used for both). */
export function ProductTemplatesSheet({ productId }) {
  const { lookups: L } = useApp();
  const p = L.products.find(x => x.id === productId);
  const [kind, setKind] = useState('renew');
  return (
    <SheetShell title={p ? p.name + ' messages' : 'Messages'} description="Reminder messages for this product, used for every language">
      <Stack>
        <Hint>These replace the general messages for {p ? p.name : 'this product'}, in English and Bangla alike. Reset to default goes back to the general message.</Hint>
        <Tabs value={kind} onValueChange={setKind}>
          <TabsList aria-label="Message type">
            <TabsTrigger value="renew" id="ptKindRenew">Renew</TabsTrigger>
            <TabsTrigger value="due" id="ptKindDue">Due</TabsTrigger>
          </TabsList>
        </Tabs>
        <TemplateEditor key={kind} scope="product" productId={productId} kind={kind} />
      </Stack>
    </SheetShell>
  );
}

/** The one long Settings form, kept for the openers.settings() callers. The Settings screen (screens/Settings.jsx) shows the same fields in sections. */
export function SettingsSheet() {
  const { lookups } = useApp();
  const s = lookups.settings;
  const { v, set } = useFields(() => ({ ...businessDraft(s), ...ratesDraft(s), ...remindersDraft(s) }));
  const [extra, setExtra] = useState(() => extraDraft(s));
  const { save, busy, error } = useSaver('settings', () => ({
    values: { ...businessValues(v), ...ratesValues(v), ...remindersValues(v), ...extraValues(extra, s) }
  }));
  return (
    <SheetShell title="Settings" description="Payment details, reminder timing and rates"
      footer={<Stack className="gap-3"><Hint>Changes apply to new reminders straight away.</Hint><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save settings</SaveButton></Stack>}>
      <Stack>
        <BusinessFields v={v} set={set} />
        <RatesFields v={v} set={set} />
        <RemindersFields v={v} set={set} />
        <div className="grid gap-3 rounded-xl border border-border bg-card/60 p-4">
          <h3 className="text-base font-extrabold">Reminder messages</h3>
          <MessageTemplates />
        </div>
        <AllSettingsFields extra={extra} setExtra={setExtra} />
      </Stack>
    </SheetShell>
  );
}

/** Which methods the pay page offers, and the number or bank account each one pays into. */
export function PayMethodsSheet() {
  const { lookups } = useApp();
  const s = lookups.settings;
  const draft = usePayMethodsDraft(s, true);
  const { save, busy, error } = useSaver('settings', () => ({ values: payMethodsValues(draft, s) }), { undo: false, keepParent: true });
  return (
    <SheetShell title="Payment methods" description="Where customers can pay, shown on every pay link"
      footer={<Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={save}>Save methods</SaveButton></Stack>}>
      <PayMethodsFields draft={draft} />
    </SheetShell>
  );
}
