import { useRef } from 'react';
import { useMigNav } from '@/screens/migration/parts';
import { useSaver } from '@/lib/store';
import { ErrorBox, WarnBox } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

const norm = s => String(s === null || s === undefined ? '' : s).toLowerCase().trim().replace(/\s+/g, ' ');

/** Every row view of a review, flat. */
export function allViews(review) {
  const out = [];
  (review.accounts || []).forEach(a => { out.push(a.row); a.lines.forEach(x => out.push(x)); a.extras.forEach(x => out.push(x)); });
  (review.orphans || []).forEach(x => out.push(x));
  (review.codes || []).forEach(x => out.push(x));
  (review.inbox || []).forEach(x => out.push(x));
  return out;
}

/** What applying the Approved rows would do, read from the review (the server stays the judge). */
/** Account rows that approved lines and extras need but that are not applied or approved yet: applied along with them. */
export function parentsToAdd(review) {
  const rows = allViews(review);
  const accounts = {};
  (review.accounts || []).forEach(a => { accounts[a.row.id] = a.row; });
  const out = [];
  (review.accounts || []).forEach(a => {
    const needs = a.lines.concat(a.extras).some(k => k.status === 'Approved');
    const r = a.row;
    if (needs && r.status !== 'Applied' && r.status !== 'Approved' && r.status !== 'Skipped' && rows.indexOf(r) >= 0) out.push(r);
  });
  return out;
}

/** The parents above that are still in Review: applying them needs an explicit "Approve and include". */
export function parentsInReview(review) { return parentsToAdd(review).filter(r => r.status !== 'Approved'); }

export function summarize(review) {
  const rows = allViews(review).filter(r => r.status === 'Approved');
  const s = { approved: rows.length, newAccounts: 0, updatedAccounts: 0, newCustomers: 0, newSales: 0, paymentDiffs: 0, unchanged: 0, codes: 0, inbox: 0 };
  const names = {};
  rows.forEach(r => {
    const m = r.match || {};
    if (r.kind === 'account') { if (m.account) s.updatedAccounts++; else s.newAccounts++; }
    else if (r.kind === 'line') {
      if (!m.customer && !names[norm(r.data.name)]) { names[norm(r.data.name)] = true; s.newCustomers++; }
      if (m.sale) {
        const due = /^(due|unpaid)$/i.test(String(r.data.status || ''));
        if (!due && m.sale.difference > 0) s.paymentDiffs++; else s.unchanged++;
      } else s.newSales++;
    } else if (r.kind === 'extra') s.newSales++;
    else if (r.kind === 'code') { if (!m.code) s.codes++; }
    else if (r.kind === 'inbox') { if (!m.inInbox) s.inbox++; }
  });
  return s;
}

const NAMES = { customers: 'customers', sales: 'sales', payments: 'payments', accounts: 'accounts', purchases: 'purchases', codes: 'codes', inbox: 'inbox rows' };
export const createdText = c => Object.keys(NAMES).filter(k => c && c[k]).map(k => c[k] + ' ' + NAMES[k]).join(', ') || 'nothing new';

/** Sticky bar shown while anything is Approved. Apply asks first, lists what it will do, and offers Undo after. */
/** Text with every known row id or Sheet!Ref turned into a link to that row. */
export function Linkified({ text, review }) {
  const nav = useMigNav();
  const map = {};
  allViews(review).forEach(v => { map[v.id] = v.id; if (v.sheet) map[v.sheet + '!' + v.ref] = v.id; });
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  if (!keys.length) return text;
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(' + keys.map(esc).join('|') + ')');
  return String(text).split(re).map((part, i) => (map[part] ? (
    <button key={i} type="button" data-testid="mig-rowlink" onClick={() => nav.go(map[part], '')}
      className="rounded-sm font-mono underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{part}</button>
  ) : part));
}

export function ApplyBar({ review, batch, onApplied, result }) {
  const s = summarize(review);
  const blocked = allViews(review).filter(r => r.status === 'Approved' && r.blocks).length;
  const skipped = (result && result.skipped) || [];
  const parents = parentsToAdd(review);
  const inReview = parentsInReview(review);
  const nav = useMigNav();
  const approveRef = useRef(false);   // set by "Approve and include" just before saving: the server then approves those account rows in the same batch
  const { save, busy, error } = useSaver('importApply', () => ({ batch, includeParents: true, approveParents: approveRef.current }), { undo: true, stay: true, after: d => onApplied(d) });
  if (!s.approved) return null;
  const list = [
    s.newAccounts ? s.newAccounts + ' new ' + (s.newAccounts === 1 ? 'account' : 'accounts') : '',
    s.updatedAccounts ? s.updatedAccounts + ' existing ' + (s.updatedAccounts === 1 ? 'account' : 'accounts') + ' updated (renewal, cost, slots)' : '',
    s.newCustomers ? s.newCustomers + ' new ' + (s.newCustomers === 1 ? 'customer' : 'customers') : '',
    s.newSales ? s.newSales + ' new ' + (s.newSales === 1 ? 'sale' : 'sales') + ' with their payments' : '',
    s.paymentDiffs ? s.paymentDiffs + ' matched ' + (s.paymentDiffs === 1 ? 'line gets' : 'lines get') + ' a payment for the difference' : '',
    s.unchanged ? s.unchanged + ' matched ' + (s.unchanged === 1 ? 'line' : 'lines') + ' with nothing to add' : '',
    s.codes ? s.codes + ' new ' + (s.codes === 1 ? 'code' : 'codes') : '',
    s.inbox ? s.inbox + ' inbox ' + (s.inbox === 1 ? 'row' : 'rows') : ''
  ].filter(Boolean);
  return (
    <div className="sticky bottom-24 z-30 grid gap-2 md:bottom-4">
      <div className="grid gap-2 rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-2xl shadow-black/30 backdrop-blur-xl">
        {/* The apply error sits inside the bar, in its own scroll area, so it never covers the rows. */}
        {error ? <div className="max-h-32 overflow-y-auto"><ErrorBox testId="mig-apply-error"><Linkified text={error} review={review} /></ErrorBox></div> : null}
        {result ? (
          <div data-testid="mig-apply-result" className="max-h-40 overflow-y-auto text-sm font-bold">
            {'Applied ' + result.applied + (skipped.length ? ', ' + skipped.length + (skipped.length === 1 ? ' needs attention' : ' need attention') : '')}
            {skipped.length ? (
              <ul data-testid="mig-skipped" className="mt-1 grid gap-1 text-xs font-bold text-bad">
                {skipped.map(k => (
                  <li key={k.rowId}><button type="button" data-testid="mig-skipped-row" onClick={() => nav.go(k.rowId, '')}
                    className="rounded-sm text-left break-words underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{k.ref}</button>{': ' + k.error}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm font-bold">{s.approved + (s.approved === 1 ? ' row approved' : ' rows approved')}</div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button id="mig-apply" type="button" className="h-11 px-5 font-extrabold" disabled={busy}>{busy ? <Spinner /> : null}{'Apply ' + s.approved + ' approved'}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{'Apply ' + s.approved + ' approved ' + (s.approved === 1 ? 'row' : 'rows') + '?'}</AlertDialogTitle>
              <AlertDialogDescription>A row that cannot be applied is skipped and listed; the rest apply together. One Undo reverses all of it.</AlertDialogDescription>
            </AlertDialogHeader>
            <ul data-testid="mig-apply-list" className="grid gap-1 text-sm font-bold">
              {list.length ? list.map(t => <li key={t}>{t}</li>) : <li>No changes to the books.</li>}
              {blocked ? <li data-testid="mig-will-skip" className="text-bad">{blocked + (blocked === 1 ? ' approved row blocks apply and will be skipped' : ' approved rows block apply and will be skipped')}</li> : null}
              {parents.map(p => <li key={p.id} data-testid="mig-also">{(p.status === 'Approved' ? 'Also applies account ' : 'Needs account ') + (p.sheet ? p.sheet + '!' + p.ref : p.id) + (p.status === 'Approved' ? '' : ' (still in Review: approve it first, or choose Approve and include)')}</li>)}
            </ul>
            {s.newCustomers > 10 ? <WarnBox testId="mig-many-customers">{s.newCustomers + ' new customers will be created. Check the names first: a typo makes a duplicate customer.'}</WarnBox> : null}
            <AlertDialogFooter>
              <AlertDialogCancel>Not yet</AlertDialogCancel>
              {inReview.length ? <AlertDialogAction id="mig-apply-include" onClick={() => { approveRef.current = true; save(); }}>Approve and include</AlertDialogAction> : null}
              <AlertDialogAction onClick={() => { approveRef.current = false; save(); }}>Apply now</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </div>
    </div>
  );
}
