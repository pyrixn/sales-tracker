import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApp, useSaver } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { useDensity } from '@/lib/density';
import { useNavGuard } from '@/lib/navGuard';
import { Chip, ErrorBox, Hint, SaveButton } from '@/components/kit';
import { VaultPinSection } from '@/components/LoginDetails';
import { AllSettingsFields, BusinessFields, MessageTemplates, PayMethodsFields, RatesFields, RemindersFields, useFields, usePayMethodsDraft } from '@/components/settings/Fields';
import { businessDraft, businessValues, differs, extraDraft, extraValues, payMethodsDraft, payMethodsValues, ratesDraft, ratesValues, remindersDraft, remindersValues } from '@/components/settings/draft';

// Settings as a screen (uplift plan 4.7). Each section keeps its own draft and saves only its own keys through useSaver('settings').
// The fields and the value rules are the ones the Settings and Payment methods sheets use (components/settings/). The message
// editor saves through its own action, as it always has. A section reports whether it holds unsaved edits; the shell asks before
// it leaves the screen. On a phone the sections are an accordion; on md and up a sub-nav on the left picks one section.

function SaveRow({ id, busy, error, disabled, onClick, children }) {
  return (
    <div className="grid gap-3">
      <ErrorBox>{error}</ErrorBox>
      <SaveButton id={id} busy={busy} disabled={disabled} onClick={onClick}>{children}</SaveButton>
    </div>
  );
}

function BusinessSection({ onDirty }) {
  const { lookups } = useApp();
  const s = lookups.settings;
  const { v, set } = useFields(() => businessDraft(s));
  const dirty = differs(businessValues, v, businessDraft(s));
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const { save, busy, error } = useSaver('settings', () => ({ values: businessValues(v) }), { stay: true });
  return (
    <>
      <BusinessFields v={v} set={set} />
      <SaveRow id="saveBusiness" busy={busy} error={error} disabled={!dirty} onClick={save}>Save business details</SaveRow>
    </>
  );
}

function RemindersSection({ onDirty }) {
  const { lookups } = useApp();
  const s = lookups.settings;
  const { v, set } = useFields(() => remindersDraft(s));
  const dirty = differs(remindersValues, v, remindersDraft(s));
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const { save, busy, error } = useSaver('settings', () => ({ values: remindersValues(v) }), { stay: true });
  return (
    <>
      <RemindersFields v={v} set={set} />
      <Hint>Changes apply to new reminders straight away.</Hint>
      <SaveRow id="saveReminders" busy={busy} error={error} disabled={!dirty} onClick={save}>Save reminder timing</SaveRow>
    </>
  );
}

// Each message saves on its own, inside the editor.
function TemplatesSection({ onDirty }) {
  return <MessageTemplates onDirty={onDirty} />;
}

function PayMethodsSection({ onDirty }) {
  const { lookups } = useApp();
  const s = lookups.settings;
  const draft = usePayMethodsDraft(s, false);   // the bKash number is edited under Business
  const dirty = differs(d => payMethodsValues(d, s), draft, payMethodsDraft(s, false));
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const { save, busy, error } = useSaver('settings', () => ({ values: payMethodsValues(draft, s) }), { undo: false, stay: true });
  return (
    <>
      <PayMethodsFields draft={draft} />
      <SaveRow id="saveMethods" busy={busy} error={error} disabled={!dirty} onClick={save}>Save methods</SaveRow>
    </>
  );
}

function RatesSection({ onDirty }) {
  const { lookups } = useApp();
  const s = lookups.settings;
  const { v, set } = useFields(() => ratesDraft(s));
  const dirty = differs(ratesValues, v, ratesDraft(s));
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const { save, busy, error } = useSaver('settings', () => ({ values: ratesValues(v) }), { stay: true });
  return (
    <>
      <RatesFields v={v} set={set} />
      <SaveRow id="saveRates" busy={busy} error={error} disabled={!dirty} onClick={save}>Save rate</SaveRow>
    </>
  );
}

const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
const DENSITIES = [['comfortable', 'Comfortable'], ['compact', 'Compact']];
// The theme and the density are kept on this device, so they need no save.
function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { density, setDensity } = useDensity();
  return (
    <div className="grid gap-3">
      <p id="themeLabel" className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Theme</p>
      <div role="group" aria-labelledby="themeLabel" className="flex flex-wrap gap-2">
        {THEMES.map(([k, label]) => <Chip key={k} testId={'theme-' + k} pressed={theme === k} onClick={() => setTheme(k)}>{label}</Chip>)}
      </div>
      <Hint>Kept on this device. System follows the device setting.</Hint>
      <p id="densityLabel" className="pt-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">Density</p>
      <div role="group" aria-labelledby="densityLabel" className="flex flex-wrap gap-2">
        {DENSITIES.map(([k, label]) => <Chip key={k} testId={'density-' + k} pressed={density === k} onClick={() => setDensity(k)}>{label}</Chip>)}
      </div>
      <Hint>Compact tightens rows on tablets and desktops. Phones keep their row height.</Hint>
    </div>
  );
}

function AllSettingsSection({ onDirty }) {
  const { lookups } = useApp();
  const s = lookups.settings;
  const [extra, setExtra] = useState(() => extraDraft(s));
  const dirty = Object.keys(extraValues(extra, s)).length > 0;
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const { save, busy, error } = useSaver('settings', () => ({ values: extraValues(extra, s) }), { stay: true });
  return (
    <>
      <AllSettingsFields extra={extra} setExtra={setExtra} />
      {Object.keys(extra).length ? <SaveRow id="saveAll" busy={busy} error={error} disabled={!dirty} onClick={save}>Save all settings</SaveRow> : null}
    </>
  );
}

const SECTIONS = [
  { id: 'business', label: 'Business', Body: BusinessSection },
  { id: 'reminders', label: 'Reminders', Body: RemindersSection },
  { id: 'templates', label: 'Message templates', Body: TemplatesSection },
  { id: 'methods', label: 'Pay methods', Body: PayMethodsSection },
  { id: 'rates', label: 'Rates', Body: RatesSection },
  { id: 'vault', label: 'Vault PIN', Body: VaultPinSection },
  { id: 'appearance', label: 'Appearance', Body: AppearanceSection },
  { id: 'all', label: 'All settings', Body: AllSettingsSection }
];

// One section. On a phone its heading is an accordion button; on md and up the sub-nav on the left is the switch and the heading is the title.
function SettingsPanel({ id, label, open, unsaved, onOpen, children }) {
  const headId = 'set-head-' + id, bodyId = 'set-body-' + id;
  return (
    <section aria-labelledby={headId} className={cn('min-w-0', !open && 'md:hidden')}>
      <h2 id={headId}>
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onOpen}
          className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-border bg-card/80 px-4 py-3 text-left md:hidden">
          <span className="flex-1 text-base font-extrabold">{label}</span>
          {unsaved ? <span className="text-micro font-bold text-warn">Unsaved</span> : null}
          <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </button>
        <span className="hidden items-center gap-3 md:flex">
          <span className="page-title flex-1 text-2xl">{label}</span>
          {unsaved ? <span className="text-micro font-bold text-warn">Unsaved</span> : null}
        </span>
      </h2>
      <div id={bodyId} className={cn('mt-3 grid gap-4 rounded-xl border border-border bg-card/60 p-4 md:mt-0', !open && 'hidden')}>
        {children}
      </div>
    </section>
  );
}

export function Settings() {
  const guard = useNavGuard();
  const [sel, setSel] = useState('business');
  const [unsaved, setUnsaved] = useState({});
  const report = useCallback((id, d) => setUnsaved(m => (!!m[id] === d ? m : { ...m, [id]: d })), []);
  const anyUnsaved = Object.values(unsaved).some(Boolean);

  useEffect(() => { guard.setDirty(anyUnsaved); }, [anyUnsaved, guard]);
  useEffect(() => () => guard.setDirty(false), [guard]);
  useEffect(() => {
    if (!anyUnsaved) return undefined;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyUnsaved]);

  return (
    <div data-testid="settings-screen" className="mx-auto grid w-full max-w-5xl gap-6 md:grid-cols-[13rem_minmax(0,1fr)] md:items-start">
      <nav aria-label="Settings sections" className="hidden md:sticky md:top-4 md:block">
        <ul className="grid gap-1">
          {SECTIONS.map(s => (
            <li key={s.id}>
              <button type="button" aria-current={sel === s.id ? 'true' : undefined} onClick={() => setSel(s.id)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-left text-sm font-bold text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground aria-[current=true]:bg-foreground/[0.07] aria-[current=true]:text-foreground">
                <span>{s.label}</span>
                {unsaved[s.id] ? <span className="text-micro font-bold text-warn">Unsaved</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="grid min-w-0 gap-3">
        {SECTIONS.map(s => {
          const Body = s.Body;
          return (
            <SettingsPanel key={s.id} id={s.id} label={s.label} open={sel === s.id} unsaved={!!unsaved[s.id]} onOpen={() => setSel(s.id)}>
              <Body onDirty={d => report(s.id, d)} />
            </SettingsPanel>
          );
        })}
      </div>
    </div>
  );
}
