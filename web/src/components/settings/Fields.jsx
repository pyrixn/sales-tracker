import { useCallback, useRef, useState } from 'react';
import { rateText } from '@/lib/format';
import { useApp } from '@/lib/store';
import { Field, Hint, Stack, TemplateEditor, Two } from '@/components/kit';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { PayMethodIcon } from '@/components/icons';
import { METHOD_ROWS, payMethodsDraft } from '@/components/settings/draft';

// The field bodies shared by the Settings screen and the Settings and Payment methods sheets. Each takes its draft and
// setter from the caller, so the caller decides what is saved together.

/** A flat draft object with one setter: set(key, value). */
export function useFields(init) {
  const [v, setV] = useState(init);
  const set = useCallback((k, val) => setV(x => ({ ...x, [k]: val })), []);
  return { v, set };
}

/** The Pay methods draft: which methods are on, which confirm from the SMS relay, and the typed numbers and text. */
export function usePayMethodsDraft(s, withBkash) {
  const [st, setSt] = useState(() => payMethodsDraft(s, withBkash));
  return {
    ...st,
    setOn: (id, c) => setSt(x => ({ ...x, on: { ...x.on, [id]: c } })),
    setAuto: (id, c) => setSt(x => ({ ...x, auto: { ...x.auto, [id]: c } })),
    set: (k, val) => setSt(x => ({ ...x, v: { ...x.v, [k]: val } }))
  };
}

export function BusinessFields({ v, set }) {
  return (
    <Stack>
      <Field label="Your bKash number (goes in reminders)" id="tBkash"><Input id="tBkash" inputMode="tel" value={v.bkash} onChange={e => set('bkash', e.target.value)} /></Field>
      <Field label="Payment page base URL (blank for default)" id="tPayBase"><Input id="tPayBase" type="url" placeholder="https://..." value={v.payBase} onChange={e => set('payBase', e.target.value)} /></Field>
      <Field label="Reminder language" id="tLang">
        <NativeSelect id="tLang" value={v.lang} onChange={e => set('lang', e.target.value)}>
          <NativeSelectOption value="en">English</NativeSelectOption>
          <NativeSelectOption value="bn">বাংলা</NativeSelectOption>
        </NativeSelect>
      </Field>
    </Stack>
  );
}

export function RemindersFields({ v, set }) {
  return (
    <Stack>
      <Two>
        <Field label="Remind days before" id="tBefore"><Input id="tBefore" inputMode="numeric" value={v.before} onChange={e => set('before', e.target.value)} /></Field>
        <Field label="Remind days after" id="tAfter"><Input id="tAfter" inputMode="numeric" value={v.after} onChange={e => set('after', e.target.value)} /></Field>
      </Two>
      <Two>
        <Field label="Due reminder every (days)" id="tDue"><Input id="tDue" inputMode="numeric" value={v.due} onChange={e => set('due', e.target.value)} /></Field>
        <Field label="Renewal grace (days)" id="tGrace"><Input id="tGrace" inputMode="numeric" value={v.grace} onChange={e => set('grace', e.target.value)} /></Field>
      </Two>
    </Stack>
  );
}

export function RatesFields({ v, set }) {
  const { lookups } = useApp();
  return (
    <Stack>
      <Field label="Manual USDT rate in BDT (blank = live Bybit rate)" id="tUsdt"><Input id="tUsdt" inputMode="decimal" value={v.usdt} onChange={e => set('usdt', e.target.value)} /></Field>
      <Hint>Current rate: {rateText(lookups.rate)}</Hint>
    </Stack>
  );
}

/** Renew and Due, in English and Bangla. Each message saves on its own, with its own button in the editor. */
export function MessageTemplates({ onDirty }) {
  const [kind, setKind] = useState('renew');
  const [lang, setLang] = useState('en');
  // The text typed in each message is kept here, so switching tabs does not lose it. unsaved: the messages that differ from what is saved.
  const drafts = useRef({});
  const unsaved = useRef(new Set());
  const mark = (key, d) => {
    if (d) unsaved.current.add(key); else unsaved.current.delete(key);
    if (onDirty) onDirty(unsaved.current.size > 0);
  };
  const key = kind + '_' + lang;
  return (
    <div className="grid gap-3">
      <Tabs value={kind} onValueChange={setKind}>
        <TabsList aria-label="Message type">
          <TabsTrigger value="renew" id="tplKindRenew">Renew</TabsTrigger>
          <TabsTrigger value="due" id="tplKindDue">Due</TabsTrigger>
        </TabsList>
      </Tabs>
      <Tabs value={lang} onValueChange={setLang}>
        <TabsList aria-label="Message language">
          <TabsTrigger value="en" id="tplLangEn">English</TabsTrigger>
          <TabsTrigger value="bn" id="tplLangBn">বাংলা</TabsTrigger>
        </TabsList>
      </Tabs>
      <TemplateEditor key={key} scope="global" kind={kind} lang={lang}
        draft={drafts.current[key]} onDraft={t => { drafts.current[key] = t; }} onDirty={d => mark(key, d)} />
    </div>
  );
}

/** Pay methods: the methods a customer can pay with, the numbers, the bank account, and the delivery and receipt text. */
export function PayMethodsFields({ draft }) {
  const { on, auto, v, setOn, setAuto, set } = draft;
  return (
    <Stack>
      <Hint>Customers pick from the methods you turn on. A method with no number is hidden from them until you add it.</Hint>
      {METHOD_ROWS.map(m => (
        <div key={m.id} className="grid gap-3 rounded-xl border border-border bg-card/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <PayMethodIcon method={m.id} className="size-6 shrink-0" />
              <Label htmlFor={'on-' + m.id} className="cursor-pointer text-base font-extrabold">{m.label}</Label>
            </div>
            <Switch id={'on-' + m.id} checked={on[m.id]} onCheckedChange={c => setOn(m.id, c)} />
          </div>
          {on[m.id] ? (
            <>
              {v[m.key] !== undefined
                ? (
                  <Field label={m.label + ' ' + m.hint} id={'n-' + m.id}>
                    <Input id={'n-' + m.id} inputMode="tel" placeholder="01XXXXXXXXX" value={v[m.key]} onChange={e => set(m.key, e.target.value)} />
                  </Field>
                ) : <Hint>Uses the {m.label} number from Business.</Hint>}
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={'auto-' + m.id} className="flex-1 text-sm font-medium">Confirm automatically from the SMS relay</Label>
                <Switch id={'auto-' + m.id} checked={auto[m.id]} onCheckedChange={c => setAuto(m.id, c)} />
              </div>
              {auto[m.id] ? null : <Hint>You confirm {m.label} payments by hand: customers send the transaction ID, then you tap Got paid.</Hint>}
            </>
          ) : null}
        </div>
      ))}
      <div className="grid gap-3 rounded-xl border border-border bg-card/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <PayMethodIcon method="bank" className="size-6 shrink-0" />
            <Label htmlFor="on-bank" className="cursor-pointer text-base font-extrabold">Bank transfer <span className="ml-1 text-xs font-medium text-muted-foreground">confirmed by hand</span></Label>
          </div>
          <Switch id="on-bank" checked={on.bank} onCheckedChange={c => setOn('bank', c)} />
        </div>
        {on.bank ? (
          <>
            <Field label="Bank name" id="bankName"><Input id="bankName" value={v.bank_name} onChange={e => set('bank_name', e.target.value)} /></Field>
            <Field label="Account name" id="bankAccName"><Input id="bankAccName" value={v.bank_account_name} onChange={e => set('bank_account_name', e.target.value)} /></Field>
            <Field label="Account number" id="bankAccNo"><Input id="bankAccNo" inputMode="numeric" value={v.bank_account_number} onChange={e => set('bank_account_number', e.target.value)} /></Field>
            <Field label="Branch" id="bankBranch"><Input id="bankBranch" value={v.bank_branch} onChange={e => set('bank_branch', e.target.value)} /></Field>
            <Field label="Routing number" id="bankRouting"><Input id="bankRouting" inputMode="numeric" value={v.bank_routing} onChange={e => set('bank_routing', e.target.value)} /></Field>
            <Field label="Note for the customer" id="bankNote" hint="Shown under the account details."><Textarea id="bankNote" rows={2} value={v.bank_note} onChange={e => set('bank_note', e.target.value)} /></Field>
          </>
        ) : null}
      </div>
      <div className="grid gap-3 rounded-xl border border-border bg-card/60 p-4">
        <h3 className="text-base font-extrabold">Delivery</h3>
        <Field label="Terms of service" id="tosText" hint="Shown on the receipt after a customer pays."><Textarea id="tosText" rows={3} value={v.tos_text} onChange={e => set('tos_text', e.target.value)} /></Field>
        <Field label="Discord link" id="discordUrl" hint="Must start with https://. Leave blank to hide."><Input id="discordUrl" inputMode="url" placeholder="https://" value={v.review_discord_url} onChange={e => set('review_discord_url', e.target.value)} /></Field>
        <Field label="Facebook link" id="facebookUrl" hint="Must start with https://. Leave blank to hide."><Input id="facebookUrl" inputMode="url" placeholder="https://" value={v.review_facebook_url} onChange={e => set('review_facebook_url', e.target.value)} /></Field>
        <Field label="Pay link expiry (hours)" id="expiryHours" hint="From 1 to 720. New links expire after this long unless you set it per link."><Input id="expiryHours" inputMode="numeric" value={v.pay_link_expiry_hours} onChange={e => set('pay_link_expiry_hours', e.target.value)} /></Field>
        <Field label="Delivery note" id="deliveryNote" hint="Your own reminder about how you deliver."><Textarea id="deliveryNote" rows={2} value={v.delivery_note} onChange={e => set('delivery_note', e.target.value)} /></Field>
      </div>
    </Stack>
  );
}

/** Every stored setting that has no field of its own, edited as text. extra: { key: text }. */
export function AllSettingsFields({ extra, setExtra }) {
  const keys = Object.keys(extra);
  if (!keys.length) return <Hint>No other settings are stored.</Hint>;
  return (
    <Stack>
      <Hint>All settings, by stored name. Edit any value; blank clears it.</Hint>
      {keys.map(k => {
        const id = 'set-' + k;
        const long = extra[k].length > 60 || extra[k].includes('\n');
        const onChange = e => setExtra(x => ({ ...x, [k]: e.target.value }));
        return (
          <Field key={k} label={k} id={id}>
            {long ? <Textarea id={id} rows={3} value={extra[k]} onChange={onChange} /> : <Input id={id} value={extra[k]} onChange={onChange} />}
          </Field>
        );
      })}
    </Stack>
  );
}
