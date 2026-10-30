import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Upload } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { notify, useApp, useInlineSave } from '@/lib/store';
import { useRead } from '@/lib/useRead';
import { Chip, Empty, ErrorBox, Field, Hint, NoteBox, Pill, Section } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApplyBar, createdText } from '@/screens/migration/ApplyBar';
import { AccountCard, CodeRow, ExtraRow, InboxRow, LineRow } from '@/screens/migration/Rows';
import { MigNav, STATUS_TONE, sourceOf } from '@/screens/migration/parts';

// Data migration: review what the staging script read from the old sheet, fix it in place, approve, then apply it as real sales,
// payments, accounts, codes and inbox rows. Shown from More while the setting migration_panel is on. The server decides every rule.

const CHUNK = 500;
const STATUSES = ['Review', 'Approved', 'Skipped', 'Applied'];
const FILTERS = [['all', 'All'], ['attention', 'Needs attention'], ['issues', 'Has issues'], ['Review', 'Review'], ['Approved', 'Approved'], ['Skipped', 'Skipped'], ['Applied', 'Applied']];

function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsText(file);
  });
}

/** Reads a staging file in the browser and sends it 500 rows at a time. Staging twice adds nothing: ids already there are skipped. */
function LoadFile({ onLoaded }) {
  const { invalidate, reload } = useApp();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    let added = 0, skipped = 0;
    try {
      let doc;
      try { doc = JSON.parse(await readText(file)); } catch (err) { throw new Error(err && err.message === 'Could not read that file.' ? err.message : 'That file is not valid JSON.'); }
      if (!doc || typeof doc.batch !== 'string' || !doc.batch.trim() || !Array.isArray(doc.rows) || !doc.rows.length) {
        throw new Error('Expected a file like { "batch": "name", "rows": [ ... ] } with at least one row.');
      }
      for (let i = 0; i < doc.rows.length; i += CHUNK) {
        const r = await call('importStage', { batch: doc.batch.trim(), rows: doc.rows.slice(i, i + CHUNK), requestId: rid() });
        if (!r.ok) throw new Error((added + skipped ? added + ' rows were staged before this. Load the file again to finish: rows already there are skipped. ' : '') + r.error);
        added += Number(r.data && r.data.added) || 0;
        skipped += Number(r.data && r.data.skipped) || 0;
      }
      notify(added + ' rows staged' + (skipped ? ', ' + skipped + ' already there' : '') + ' in ' + doc.batch.trim());
      onLoaded(doc.batch.trim());
    } catch (err) {
      setError(err.message || 'Could not load the file.');
    } finally {
      setBusy(false);
      invalidate();
      reload();
    }
  }

  return (
    <div className="grid gap-2">
      <input ref={input} id="mig-file" type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-label="Staging file" onChange={onFile} />
      <Button type="button" variant="outline" className="h-11 w-full font-bold" disabled={busy} onClick={() => input.current && input.current.click()}>
        {busy ? <Spinner /> : <Upload />}Load staging file
      </Button>
      <Hint>Make the file with <span className="font-mono">node tools/stage-tracking.js &lt;xlsx&gt; --out file.json</span>, then load it here. Add <span className="font-mono">--keep-logins</span> to keep sheet logins as encrypted login details (needs VAULT_KEY on the server); delete that file after loading.</Hint>
      <ErrorBox testId="mig-file-error">{error}</ErrorBox>
    </div>
  );
}

function Counts({ counts }) {
  const total = {};
  STATUSES.forEach(s => { total[s] = 0; });
  Object.keys(counts || {}).forEach(k => STATUSES.forEach(s => { total[s] += (counts[k] && counts[k][s]) || 0; }));
  return (
    <ul aria-label="Rows per status" className="flex flex-wrap gap-2">
      {STATUSES.map(s => <li key={s}><Pill tone={STATUS_TONE[s]}>{s + ' ' + total[s]}</Pill></li>)}
    </ul>
  );
}

function AddRow({ batch, kind, label }) {
  const add = useInlineSave('importAdd', () => ({ batch, kind, data: {} }));
  return (
    <div className="px-4 py-3">
      <Button type="button" size="sm" variant="outline" className="h-11 px-4 font-bold" onClick={() => add(null, { message: label + ' added' })}><Plus />{'Add ' + label}</Button>
    </div>
  );
}

function List({ rows, render, batch, kind, label, empty }) {
  return (
    <Section title={label.charAt(0).toUpperCase() + label.slice(1) + 's'} count={rows.length}>
      <div data-cell-group="" className="divide-y divide-border">
        {rows.length ? rows.map(render) : <Empty>{empty}</Empty>}
      </div>
      {kind ? <AddRow batch={batch} kind={kind} label={label} /> : null}
    </Section>
  );
}

export function Migration() {
  const [batch, setBatch] = useState('');
  const [tab, setTab] = useState('accounts');
  const [filter, setFilter] = useState('all');
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState(null);
  const { data, loading, error, refetch } = useRead('importReview', batch ? { batch } : {});

  // Scroll to the target row once its tab and card are open (a few frames: the card opens in its own effect), highlight it, focus the field.
  useEffect(() => {
    if (!target) return undefined;
    let tries = 0, raf = 0, timer = 0;
    const find = () => {
      const el = Array.from(document.querySelectorAll('[data-testid="mig-row"]')).find(n => n.getAttribute('data-row') === String(target.rowId));
      if (!el) { if (tries++ < 30) raf = requestAnimationFrame(find); return; }
      el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      el.setAttribute('data-highlight', 'true');
      timer = window.setTimeout(() => el.removeAttribute('data-highlight'), 2500);
      const ctl = target.field ? el.querySelector('[data-field="' + target.field + '"] button, [data-field="' + target.field + '"] input, [data-field="' + target.field + '"] select') : null;
      const focusable = ctl || el.querySelector('button, input, select');
      if (focusable) focusable.focus({ preventScroll: true });
      if (target.edit && ctl && ctl.tagName === 'BUTTON') ctl.click();
    };
    raf = requestAnimationFrame(find);
    return () => { cancelAnimationFrame(raf); };
  }, [target]);

  if (loading && !data) return <div className="mx-auto grid max-w-4xl gap-4" aria-busy="true"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (!data) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        <ErrorBox testId="mig-error">{error || 'Could not load.'}</ErrorBox>
        <Button type="button" variant="outline" className="h-11 w-full font-bold" onClick={refetch}><RefreshCw />Retry</Button>
      </div>
    );
  }

  const batches = data.batches || [];
  const current = data.batch || batch;
  const q = search.trim().toLowerCase();
  const byStatus = v => (filter === 'all' ? true : filter === 'issues' ? v.issues.length > 0 : filter === 'attention' ? (v.issues.length > 0 || !!v.blocks) : v.status === filter);
  const bySearch = v => !q || [sourceOf(v), v.id, v.data.name, v.data.label, v.data.profile, v.data.productHint, v.data.code, v.data.Transaction_ID, v.data.accountRef]
    .some(x => x !== undefined && x !== null && String(x).toLowerCase().indexOf(q) >= 0);
  const passes = v => byStatus(v) && bySearch(v);
  const accounts = data.accounts || [];

  /** Which tab holds a row. */
  function tabOf(id) {
    if (accounts.some(a => a.row.id === id || a.lines.concat(a.extras).some(k => k.id === id))) return 'accounts';
    if ((data.orphans || []).some(v => v.id === id)) return 'orphans';
    if ((data.codes || []).some(v => v.id === id)) return 'codes';
    if ((data.inbox || []).some(v => v.id === id)) return 'inbox';
    return '';
  }
  const nav = {
    target,
    go(rowId, field, edit) {
      const t = tabOf(rowId);
      if (!t) { notify('That row is no longer in this batch.'); return; }
      setTab(t); setFilter('all'); setSearch('');
      setTarget({ rowId, field: field || '', edit: !!edit, n: Date.now() });
    }
  };
  const kindCount = k => Object.keys((data.counts && data.counts[k]) || {}).reduce((a, s) => a + data.counts[k][s], 0);
  const empty = !batches.length;

  return (
    <MigNav.Provider value={nav}>
    <div className="mx-auto grid max-w-4xl gap-4">
      <section className="grid gap-4 rounded-xl border border-border bg-card/80 p-4 backdrop-blur-sm">
        {batches.length ? (
          <Field label="Batch" id="mig-batch">
            <NativeSelect id="mig-batch" className="h-11" value={current} onChange={e => { setBatch(e.target.value); setResult(null); }}>
              {batches.map(b => <NativeSelectOption key={b.batch} value={b.batch}>{b.batch + ' · ' + b.rows + ' rows, ' + b.applied + ' applied'}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        ) : null}
        {!empty ? <Counts counts={data.counts} /> : null}
        <LoadFile onLoaded={b => { setBatch(b); setResult(null); }} />
      </section>

      <ErrorBox testId="mig-error">{error}</ErrorBox>
      {result ? <NoteBox testId="mig-result">{'Applied ' + result.applied + (result.applied === 1 ? ' row. Created ' : ' rows. Created ') + createdText(result.created) + '.'}</NoteBox> : null}

      {empty ? (
        <Section title="Staged rows"><Empty>No staged rows. Load a staging file.</Empty></Section>
      ) : (
        <>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-11 w-full" aria-label="Kind of row">
              <TabsTrigger value="accounts" className="font-bold">{'Accounts ' + kindCount('account')}</TabsTrigger>
              <TabsTrigger value="codes" className="font-bold">{'Codes ' + kindCount('code')}</TabsTrigger>
              <TabsTrigger value="inbox" className="font-bold">{'Inbox ' + kindCount('inbox')}</TabsTrigger>
              <TabsTrigger value="orphans" className="font-bold">{'Orphans ' + (data.orphans || []).length}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="grid gap-1">
            <label htmlFor="mig-search" className="eyebrow px-1">Search rows</label>
            <Input id="mig-search" type="search" className="h-11" value={search} onChange={e => setSearch(e.target.value)} placeholder="Ref like Spotify!A25, name or label" />
          </div>
          <div role="group" aria-label="Filter rows" className="flex flex-wrap gap-2">
            {FILTERS.map(f => <Chip key={f[0]} pressed={filter === f[0]} onClick={() => setFilter(f[0])}>{f[1]}</Chip>)}
          </div>

          {tab === 'accounts' ? (
            <div className="grid gap-4">
              {accounts.length ? accounts.map(a => {
                const selfHit = passes(a.row);
                const kids = a.lines.concat(a.extras).filter(k => passes(k) || (selfHit && byStatus(k)));
                if ((filter !== 'all' || q) && !selfHit && !kids.length) return null;
                return <AccountCard key={a.row.id} a={a} batch={current} kids={kids} startOpen={accounts.length <= 6} />;
              }) : <Section title="Accounts"><Empty>This batch has no account rows.</Empty></Section>}
            </div>
          ) : null}
          {tab === 'codes' ? <List rows={(data.codes || []).filter(passes)} render={v => <CodeRow key={v.id} v={v} />} batch={current} kind="code" label="code" empty="No code rows." /> : null}
          {tab === 'inbox' ? <List rows={(data.inbox || []).filter(passes)} render={v => <InboxRow key={v.id} v={v} />} batch={current} kind="inbox" label="inbox row" empty="No inbox rows." /> : null}
          {tab === 'orphans' ? (
            <List rows={(data.orphans || []).filter(passes)} batch={current} label="orphan" empty="No orphans. Every line has an account row."
              render={v => (v.kind === 'line' ? <LineRow key={v.id} v={v} orphan /> : <ExtraRow key={v.id} v={v} orphan />)} />
          ) : null}
          <ApplyBar review={data} batch={current} result={result} onApplied={d => setResult(d)} />
        </>
      )}
    </div>
    </MigNav.Provider>
  );
}
