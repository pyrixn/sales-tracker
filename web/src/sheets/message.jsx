import { useEffect, useRef, useState } from 'react';
import { Check, Copy, MessageCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { call } from '@/lib/api';
import { copyText, markReminder } from '@/lib/reminders';
import { useApp, useSheetClose } from '@/lib/store';
import { ErrorBox, Field, Hint, SheetShell, Stack } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Preview of one reminder message, built by the server (`reminderMessage`). The text is editable
 * but edits stay on this screen: they are never saved. Copy, WhatsApp and Messenger use the text as shown.
 */
export function ReminderSheet({ saleId, kind, customerId }) {
  const { reload } = useApp();
  const close = useSheetClose();
  const [built, setBuilt] = useState(null);
  const [text, setText] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // First load: the server picks the language; there is no second fetch for it.
  useEffect(() => {
    let live = true;
    setLoadError('');
    call('reminderMessage', { saleId, kind }).then(r => {
      if (!live) return;
      if (!r.ok) { setLoadError(r.error || 'Could not build the message.'); return; }
      setBuilt(r.data);
      setText(r.data.message);
    });
    return () => { live = false; };
  }, [saleId, kind]);

  // A language switch rebuilds the text. If it fails, the sheet and the user's text stay as they were.
  async function pickLang(next) {
    const mine = ++seq.current;
    setSwitching(true); setNotice('');
    const r = await call('reminderMessage', { saleId, kind, lang: next });
    if (mine !== seq.current) return;
    setSwitching(false);
    if (!r.ok) { setNotice(r.error || 'Could not switch the language.'); return; }
    setBuilt(r.data);
    setText(r.data.message);
  }

  if (loadError) return <SheetShell title="Reminder"><ErrorBox>{loadError}</ErrorBox></SheetShell>;
  if (!built) return <SheetShell title="Reminder"><Stack><Skeleton className="h-40 w-full" /></Stack></SheetShell>;

  const channel = built.channel;
  const link = built.link;
  const empty = !text.trim();
  const locked = switching || empty;

  async function copy() {
    const ok = await copyText(text);
    toast(ok ? 'Message copied' : 'Select the text and copy it');
  }
  // The built link carries the original text; swap in the edited text for WhatsApp.
  const waHref = link && channel === 'WhatsApp' ? link.replace(/\?.*$/, '') + '?text=' + encodeURIComponent(text) : '';
  async function sent() {
    setBusy(true); setNotice('');
    const r = await markReminder({ saleId, customerId, kind, channel }, 'sent');
    setBusy(false);
    if (!r.ok) { setNotice(r.error || 'Could not mark as sent.'); return; }
    toast('Marked as sent');
    reload();
    close();
  }

  return (
    <SheetShell title="Reminder" description="Check the message, then copy it or open the chat"
      footer={(
        <Stack className="gap-3">
          <ErrorBox testId="msgNotice">{notice}</ErrorBox>
          {empty ? <Hint id="msgEmptyHint">Write a message first.</Hint> : null}
          <Button id="msgSent" type="button" variant="outline" size="lg" className="w-full font-bold" onClick={sent} disabled={busy || locked}>
            <Check />Mark as sent
          </Button>
        </Stack>
      )}>
      <Stack>
        <Field label="Language" id="msgLang">
          <NativeSelect id="msgLang" value={built.lang} disabled={switching} onChange={e => pickLang(e.target.value)}>
            <NativeSelectOption value="en">English</NativeSelectOption>
            <NativeSelectOption value="bn">বাংলা</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field label="Message" id="msgText" hint="Edits here are not saved. They only change what you copy or send now.">
          <Textarea id="msgText" rows={9} value={text} onChange={e => setText(e.target.value)} />
        </Field>
        <div className="grid gap-2">
          <Button id="msgCopy" type="button" size="lg" className="font-extrabold" onClick={copy} disabled={locked}><Copy />Copy</Button>
          {channel === 'WhatsApp' ? (
            waHref
              ? <Button id="msgWhatsApp" asChild variant="outline" size="lg" className="font-bold">
                  <a href={locked ? undefined : waHref} aria-disabled={locked || undefined} target="_blank" rel="noopener"><MessageCircle />Open WhatsApp</a>
                </Button>
              : <Hint id="msgNoHandle">No handle saved for this customer, so WhatsApp cannot open. Copy the message instead.</Hint>
          ) : null}
          {channel === 'Messenger' ? (
            link
              ? <Button id="msgMessenger" asChild variant="outline" size="lg" className="font-bold">
                  <a href={locked ? undefined : link} aria-disabled={locked || undefined} target="_blank" rel="noopener" onClick={locked ? undefined : copy}><Send />Copy and open Messenger</a>
                </Button>
              : <Hint id="msgNoHandle">No handle saved for this customer, so Messenger cannot open. Copy the message instead.</Hint>
          ) : null}
        </div>
      </Stack>
    </SheetShell>
  );
}
