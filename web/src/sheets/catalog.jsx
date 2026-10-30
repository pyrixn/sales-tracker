import { useId, useState } from 'react';
import { Layers, Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { call, rid } from '@/lib/api';
import { num, tk } from '@/lib/format';
import { notify, useApp, useHoldRefresh, useSaver } from '@/lib/store';
import { ConfirmButton, Empty, ErrorBox, Field, Hint, ProductTree, Row, Section, SaveButton, SheetShell, Stack, Two } from '@/components/kit';
import { Options } from '@/sheets/sale';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

function Footer({ error, busy, onSave, children }) {
  return <Stack className="gap-3"><ErrorBox>{error}</ErrorBox><SaveButton busy={busy} onClick={onSave}>{children}</SaveButton></Stack>;
}

/** Delete with a confirm step. Runs `action` with the id payload, then refreshes; the list underneath stays open. `onDone` runs after a successful delete (an edit sheet closes itself with it). */
export function DeleteButton({ label, what, action, payload, attr, onDone }) {
  const { reload } = useApp();
  async function run() {
    const r = await call(action, { ...payload, requestId: rid() });
    if (!r.ok) { notify(r.error); return; }
    notify((r.data && r.data.message) || 'Deleted', { undo: true, batchId: r.data && r.data.batchId, onUndo: reload });
    if (onDone) onDone();
    reload();
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="text-bad hover:text-bad" {...attr}>{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{'Delete ' + what + '?'}</AlertDialogTitle>
          <AlertDialogDescription>You can undo this right after from the toast.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={run}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Products ──────────────────────────────────────────────────────────
const DELIVERS = [{ value: 'account', label: 'Shared account seat' }, { value: 'code', label: 'Code (key, gift card)' }];

/** Free-text category with the categories already in use offered as suggestions. */
function CategoryField({ value, onChange }) {
  const { lookups: L } = useApp();
  const listId = useId();
  const cats = L.products.map(p => p.category).filter((c, i, a) => c && a.indexOf(c) === i).sort();
  return (
    <Field label="Category" id="pCat" hint="Type a new one or pick one you already use.">
      <Input id="pCat" list={listId} maxLength={40} autoComplete="off" placeholder="e.g. Streaming" value={value} onChange={e => onChange(e.target.value)} />
      <datalist id={listId}>{cats.map(c => <option key={c} value={c} />)}</datalist>
    </Field>
  );
}

/** "Variant of": top-level products only (a variant cannot have variants). */
function ParentField({ value, onChange, exclude, disabled, hint }) {
  const { lookups: L } = useApp();
  const tops = L.products.filter(p => !p.parentId && p.id !== exclude);
  return (
    <Field label="Variant of (optional)" id="pParent" hint={hint || 'Leave blank for a top-level product.'}>
      <NativeSelect id="pParent" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        <NativeSelectOption value="">None, a top-level product</NativeSelectOption>
        <Options list={tops.map(p => ({ value: p.id, label: p.name }))} />
      </NativeSelect>
    </Field>
  );
}

export function ProductSheet({ onCreated }) {
  const { lookups: L } = useApp();
  const [name, setName] = useState('');
  const [pid, setPid] = useState('');
  const [cat, setCat] = useState('Subscription');
  const [delivers, setDelivers] = useState('account');
  const [letter, setLetter] = useState('');
  const [parent, setParent] = useState('');
  const [cycle, setCycle] = useState('30');
  const [slots, setSlots] = useState('5');
  const [cost, setCost] = useState('');
  const [codeCost, setCodeCost] = useState('');
  const [price, setPrice] = useState('');
  const letters = L.products.map(p => p.letter).filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
  const { save, busy, error } = useSaver('addProduct', () => {
    const v = { name, productId: pid.trim(), category: cat, deliversAs: delivers, letter, parentId: parent, price: num(price, 'Price') };
    if (delivers === 'code') v.codeCost = num(codeCost, 'Code cost') || 0;
    else { v.cycleDays = num(cycle, 'Days'); v.slots = num(slots, 'People per account'); v.accountCost = num(cost, 'Account cost'); }
    return v;
  }, { keepParent: !!onCreated, after: d => { if (onCreated && d && d.productId) onCreated(d.productId); } });
  return (
    <SheetShell title="New product" description="Add a subscription or code product to the catalog" footer={<Footer error={error} busy={busy} onSave={save}>Create product</Footer>}>
      <Stack>
        <Field label="Name" id="pName"><Input id="pName" placeholder="e.g. Disney+" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Product ID (optional)" id="pId" hint="Capital letters and numbers only. Leave blank to make it from the name.">
          <Input id="pId" autoComplete="off" placeholder="e.g. DISNEY" value={pid} onChange={e => setPid(e.target.value.toUpperCase())} />
        </Field>
        <CategoryField value={cat} onChange={setCat} />
        <Two>
          <Field label="Sold as" id="pDelivers">
            <NativeSelect id="pDelivers" value={delivers} onChange={e => setDelivers(e.target.value)}><Options list={DELIVERS} /></NativeSelect>
          </Field>
          <Field label="Reference letters" id="pLetter"><Input id="pLetter" maxLength={3} autoComplete="off" placeholder="D" value={letter} onChange={e => setLetter(e.target.value.toUpperCase())} /></Field>
        </Two>
        <ParentField value={parent} onChange={setParent} />
        {delivers === 'account' ? (
          <>
            <Two>
              <Field label="Renews every (days)" id="pCycle"><Input id="pCycle" inputMode="numeric" value={cycle} onChange={e => setCycle(e.target.value)} /></Field>
              <Field label="People per account" id="pSlots"><Input id="pSlots" inputMode="numeric" value={slots} onChange={e => setSlots(e.target.value)} /></Field>
            </Two>
            <Field label="One account costs" id="pCost"><Input id="pCost" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} /></Field>
          </>
        ) : (
          <Field label="One code costs" id="pCodeCost"><Input id="pCodeCost" inputMode="decimal" value={codeCost} onChange={e => setCodeCost(e.target.value)} /></Field>
        )}
        <Field label="Your usual price per person" id="pPrice"><Input id="pPrice" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></Field>
        <Hint>{'Letters in use: ' + letters + '. Code products may share G.'}</Hint>
      </Stack>
    </SheetShell>
  );
}

/** Name, category, parent and price of an existing product. Only what changed is sent. */
export function EditProductSheet({ productId }) {
  const { lookups: L } = useApp();
  const p = L.products.find(x => x.id === productId);
  const [name, setName] = useState(p ? p.name : '');
  const [cat, setCat] = useState(p ? p.category : '');
  const [parent, setParent] = useState(p ? p.parentId : '');
  const [price, setPrice] = useState(p ? String(p.price) : '');
  const { save, busy, error } = useSaver('editProduct', () => {
    const v = { productId };
    if (name.trim() !== p.name) v.name = name.trim();
    if (cat.trim() !== (p.category || '')) v.category = cat.trim();
    if (parent !== (p.parentId || '')) v.parentId = parent;
    const pr = num(price, 'Price');
    if (pr === null) throw new Error('Price must be a number.');
    if (pr !== p.price) v.price = pr;
    if (Object.keys(v).length === 1) throw new Error('Nothing changed.');
    return v;
  }, { keepParent: true });
  if (!p) return <SheetShell title="Edit product"><Hint>This product no longer exists.</Hint></SheetShell>;
  const hasVariants = L.products.some(x => x.parentId === p.id);
  return (
    <SheetShell title="Edit product" description={'Change ' + p.name} footer={<Footer error={error} busy={busy} onSave={save}>Save changes</Footer>}>
      <Stack>
        <Hint>{'Product ID ' + p.id + '. The ID, reference letters and cost are fixed once a product exists.'}</Hint>
        <Field label="Name" id="pName"><Input id="pName" value={name} onChange={e => setName(e.target.value)} /></Field>
        <CategoryField value={cat} onChange={setCat} />
        <ParentField value={parent} onChange={setParent} exclude={p.id} disabled={hasVariants}
          hint={hasVariants ? 'This product has variants, so it stays at the top level.' : 'Leave blank for a top-level product.'} />
        <Field label="Your usual price per person" id="pPrice"><Input id="pPrice" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></Field>
        <PublicListing product={p} />
      </Stack>
    </SheetShell>
  );
}

/**
 * The website side of a product: shown on the website only when switched on, with a web address. Saves on its own button, so only
 * the fields that changed are sent. The public price applies to website orders; blank means the usual price.
 */
function PublicListing({ product: p }) {
  const [on, setOn] = useState(!!p.public);
  const [slug, setSlug] = useState(p.slug || '');
  const [desc, setDesc] = useState(p.description || '');
  const [image, setImage] = useState(p.imagePath || '');
  const [order, setOrder] = useState(String(p.sortOrder || 0));
  const [pub, setPub] = useState(p.publicPrice === '' ? '' : String(p.publicPrice));
  const { save, busy, error } = useSaver('editProductPublic', () => {
    const v = { productId: p.id };
    if (on !== !!p.public) v.public = on;
    if (slug.trim().toLowerCase() !== (p.slug || '')) v.slug = slug.trim();
    if (desc.trim() !== (p.description || '')) v.description = desc.trim();
    if (image.trim() !== (p.imagePath || '')) v.imagePath = image.trim();
    const so = num(order, 'Sort order');
    if (so === null) throw new Error('Sort order must be a whole number.');
    if (so !== p.sortOrder) v.sortOrder = so;
    const pr = pub.trim() === '' ? '' : num(pub, 'Public price');
    if (pr === null) throw new Error('Public price must be a number, or blank for the usual price.');
    if (pr !== p.publicPrice) v.publicPrice = pr;
    if (Object.keys(v).length === 1) throw new Error('Nothing changed.');
    return v;
  }, { keepParent: true });
  return (
    <div className="grid gap-4 border-t border-border pt-4" data-testid="public-listing">
      <div>
        <div className="text-sm font-bold">On your website</div>
        <Hint>Nothing is shown on the website until you switch this on. The pay link and the panel work the same either way.</Hint>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold" id="pPublicLabel">Show on the website</span>
        <Switch id="pPublic" aria-labelledby="pPublicLabel" checked={on} onCheckedChange={setOn} />
      </div>
      <Field label="Web address" id="pSlug" hint="Lowercase letters, numbers and hyphens, for example netflix-one-month.">
        <Input id="pSlug" autoComplete="off" value={slug} onChange={e => setSlug(e.target.value)} />
      </Field>
      <Field label="Description" id="pDesc"><Textarea id="pDesc" rows={3} value={desc} onChange={e => setDesc(e.target.value)} /></Field>
      <Field label="Image path" id="pImage" hint="A storage path such as products/netflix.png. Upload the image in Supabase Storage first."><Input id="pImage" autoComplete="off" value={image} onChange={e => setImage(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Sort order" id="pSort"><Input id="pSort" inputMode="numeric" value={order} onChange={e => setOrder(e.target.value)} /></Field>
        <Field label="Public price" id="pPubPrice" hint="Blank uses your usual price."><Input id="pPubPrice" inputMode="decimal" value={pub} onChange={e => setPub(e.target.value)} /></Field>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <SaveButton id="saveListing" busy={busy} onClick={save}>Save website listing</SaveButton>
    </div>
  );
}

function EditProductButton({ product, openers }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={'Edit ' + product.name} onClick={() => openers.editProduct(product.id)}><Pencil /></Button>
  );
}

// ── Accounts ──────────────────────────────────────────────────────────
export function AccountsSheet({ openers }) {
  const { lookups: L } = useApp();
  return (
    <SheetShell title="Accounts" description="Shared accounts and how full they are">
      <Stack>
        <Button id="addA" type="button" size="lg" className="font-extrabold" onClick={() => openers.addAccount()}><Plus />Add account</Button>
        <ProductTree products={L.products.filter(p => p.deliversAs !== 'code')} collapsedKey="accounts"
          renderMeta={p => (
            <>
              <Button type="button" size="sm" variant="ghost" data-product-messages={p.id} onClick={() => openers.productTemplates(p.id)}>Messages</Button>
              <EditProductButton product={p} openers={openers} />
            </>
          )}
          renderBody={p => {
            const list = L.accounts.filter(a => a.productId === p.id);
            return list.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {list.map(a => (
                  <Row key={a.id} title={a.id + ' · ' + a.label} wrap
                    detail={tk(a.cost) + ' · ' + (a.slots - Math.max(0, a.free)) + ' of ' + a.slots + ' used' + (a.status !== 'Active' ? ' · ' + a.status : '')}
                    trail={<Button type="button" size="sm" variant="outline" onClick={() => openers.purchase(a.id)}>Renewed it</Button>} />
                ))}
              </div>
            ) : null;
          }} />
      </Stack>
    </SheetShell>
  );
}

export function AddAccountSheet({ productId }) {
  const { lookups: L } = useApp();
  const subs = L.products.filter(p => p.deliversAs !== 'code');
  const [prod, setProd] = useState(productId || (subs[0] ? subs[0].id : ''));
  const [label, setLabel] = useState('');
  const [cost, setCost] = useState('');
  const [slots, setSlots] = useState('');
  const [wallet, setWallet] = useState(L.wallets[0] ? L.wallets[0].id : '');
  const [till, setTill] = useState('');
  const { save, busy, error } = useSaver('addAccount', () => ({
    productId: prod, label, cycleCost: num(cost, 'Cost'), slots: num(slots, 'People'), paidWith: wallet, renewalDate: till
  }), { keepParent: true });
  return (
    <SheetShell title="Add account" description="Add a shared account to a product" footer={<Footer error={error} busy={busy} onSave={save}>Add account</Footer>}>
      <Stack>
        <Field label="Product"><div role="group" aria-label="Product"><ProductTree products={subs} selected={prod} onSelect={setProd} collapsedKey="addAccount" /></div></Field>
        <Field label="Label (login email, never the password)" id="aLabel"><Input id="aLabel" autoComplete="off" value={label} onChange={e => setLabel(e.target.value)} /></Field>
        <Two>
          <Field label="It cost" id="aCost"><Input id="aCost" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} /></Field>
          <Field label="People it holds" id="aSlots"><Input id="aSlots" inputMode="numeric" value={slots} onChange={e => setSlots(e.target.value)} /></Field>
        </Two>
        <Two>
          <Field label="Paid with" id="aWallet"><NativeSelect id="aWallet" value={wallet} onChange={e => setWallet(e.target.value)}><Options list={L.wallets.map(w => ({ value: w.id, label: w.label + ' (' + w.id + ')' }))} /></NativeSelect></Field>
          <Field label="Renews on" id="aTill"><Input id="aTill" type="date" value={till} onChange={e => setTill(e.target.value)} /></Field>
        </Two>
      </Stack>
    </SheetShell>
  );
}

// ── Wallets ───────────────────────────────────────────────────────────
export function WalletsSheet() {
  const { lookups: L } = useApp();
  const [label, setLabel] = useState('');
  const [type, setType] = useState(L.walletTypes[0] || '');
  const [last4, setLast4] = useState('');
  const { save, busy, error } = useSaver('addWallet', () => ({ label, type, last4 }));
  return (
    <SheetShell title="Wallets" description="Cards and mobile wallets you pay with" footer={<Footer error={error} busy={busy} onSave={save}>Add wallet</Footer>}>
      <Stack>
        <Section title="Your wallets" count={L.wallets.length}>
          {L.wallets.map(w => <Row key={w.id} title={w.label} detail={w.id} />)}
        </Section>
        <h3 className="eyebrow">Add a wallet</h3>
        <Field label="Name" id="wLabel"><Input id="wLabel" placeholder="e.g. City Bank card" value={label} onChange={e => setLabel(e.target.value)} /></Field>
        <Two>
          <Field label="Type" id="wType"><NativeSelect id="wType" value={type} onChange={e => setType(e.target.value)}><Options list={L.walletTypes} /></NativeSelect></Field>
          <Field label="Last 4 digits" id="wLast"><Input id="wLast" inputMode="numeric" maxLength={4} value={last4} onChange={e => setLast4(e.target.value)} /></Field>
        </Two>
      </Stack>
    </SheetShell>
  );
}

// ── Suppliers ─────────────────────────────────────────────────────────
export function SuppliersSheet({ openers }) {
  const { lookups: L } = useApp();
  const sups = L.suppliers || [];
  return (
    <SheetShell title="Suppliers" description="Who you buy from, and your markup on each">
      <Stack>
        <Button id="addSup" type="button" size="lg" className="font-extrabold" onClick={() => openers.addSupplier()}><Plus />Add supplier</Button>
        <Section title="Suppliers & markups" icon={Truck} count={sups.length}>
          {sups.length ? sups.map(s => (
            <Row key={s.id} wrap title={s.name + ' (' + s.currency + ')'}
              detail={(
                <>
                  <span className="block">{[[s.contactChannel, s.contact].filter(Boolean).join(' '), 'Markup ' + s.markupPercent + '%', s.notes].filter(Boolean).join(' · ')}</span>
                  {(s.products || []).length ? <span className="block">{'Supplies: ' + s.products.map(x => x.name).join(', ')}</span> : null}
                </>
              )}
              trail={(
                <div className="flex shrink-0 items-center gap-1">
                  <span className="money mr-1 text-sm font-semibold">{s.markupPercent + '%'}</span>
                  <Button type="button" size="sm" variant="outline" data-sup-edit={s.id} onClick={() => openers.editSupplier(s.id)}>Edit</Button>
                  <DeleteButton label="Delete" what={'supplier ' + s.name} action="deleteSupplier" payload={{ supplierId: s.id }} attr={{ 'data-sup-del': s.id }} />
                </div>
              )} />
          )) : <Empty>No suppliers configured yet.</Empty>}
        </Section>
      </Stack>
    </SheetShell>
  );
}

const CHANNELS = ['Telegram', 'WhatsApp', 'Facebook', 'Email', 'Other'];

function SupplierForm({ initial, action, title, cta, extra }) {
  const [name, setName] = useState(initial.name || '');
  const [curr, setCurr] = useState(initial.currency || 'BDT');
  const [markup, setMarkup] = useState(initial.markupPercent === undefined ? '' : String(initial.markupPercent));
  const [contact, setContact] = useState(initial.contact || '');
  const [notes, setNotes] = useState(initial.notes || '');
  const [channel, setChannel] = useState(initial.contactChannel || '');
  const supplies = (initial.products || []).map(p => p.name);
  const { save, busy, error } = useSaver(action, () => ({
    ...extra, name, currency: curr, markupPercent: Number(markup) || 0, contact, contactChannel: channel, notes
  }), { keepParent: true });
  return (
    <SheetShell title={title} description="Supplier details" footer={<Footer error={error} busy={busy} onSave={save}>{cta}</Footer>}>
      <Stack>
        <Field label="Supplier name" id="sName"><Input id="sName" placeholder="e.g. Bybit P2P Vendor X" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Two>
          <Field label="Currency" id="sCurr"><NativeSelect id="sCurr" value={curr} onChange={e => setCurr(e.target.value)}><Options list={['BDT', 'USDT']} /></NativeSelect></Field>
          <Field label="Markup %" id="sMarkup"><Input id="sMarkup" inputMode="decimal" placeholder="0" value={markup} onChange={e => setMarkup(e.target.value)} /></Field>
        </Two>
        <Field label="How you reach them" id="sChannel">
          <NativeSelect id="sChannel" value={channel} onChange={e => setChannel(e.target.value)}>
            <NativeSelectOption value="">Not set</NativeSelectOption>
            <Options list={CHANNELS} />
          </NativeSelect>
        </Field>
        {channel || contact ? (
          <Field label={channel ? channel + ' handle or number' : 'Contact'} id="sContact">
            <Input id="sContact" autoComplete="off" placeholder={channel === 'Email' ? 'name@example.com' : channel === 'Telegram' ? '@username' : ''} value={contact} onChange={e => setContact(e.target.value)} />
          </Field>
        ) : null}
        <Field label="Notes" id="sNotes"><Input id="sNotes" value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        {initial.products ? <Hint className="break-words">{'Supplies: ' + (supplies.length ? supplies.join(', ') : 'no products yet')}</Hint> : null}
      </Stack>
    </SheetShell>
  );
}
export function AddSupplierSheet() { return <SupplierForm initial={{}} action="addSupplier" title="Add supplier" cta="Save supplier" extra={{}} />; }
export function EditSupplierSheet({ id }) {
  const { lookups: L } = useApp();
  const s = (L.suppliers || []).find(x => x.id === id);
  if (!s) return <SheetShell title="Edit supplier"><Hint>This supplier no longer exists.</Hint></SheetShell>;
  return <SupplierForm initial={s} action="editSupplier" title="Edit supplier" cta="Save changes" extra={{ supplierId: id }} />;
}

// ── Gift-card batches and codes ───────────────────────────────────────
export function BatchesSheet({ openers }) {
  const { lookups: L } = useApp();
  const prods = L.products.filter(p => p.deliversAs === 'code');
  const batches = L.batches || [];
  return (
    <SheetShell title="Gift cards & batches" description="Code stock and on-demand batches">
      <Stack>
        <div className="grid grid-cols-2 gap-2">
          <Button id="addBatchBtn" type="button" size="lg" className="font-extrabold" onClick={() => openers.addBatch()}><Plus />On-demand batch</Button>
          <Button id="addCodeBtn" type="button" size="lg" variant="outline" className="font-bold" onClick={() => openers.codes()}><Plus />Add codes</Button>
        </div>
        <Section title="Stock by product" icon={Layers}>
          {prods.length ? prods.map(p => (
            <Row key={p.id} title={p.name} trail={(
              <div className="flex shrink-0 items-center gap-1">
                <span className="money mr-1 text-sm font-semibold">{L.codes.filter(c => c.productId === p.id).length + ' in stock'}</span>
                <EditProductButton product={p} openers={openers} />
              </div>
            )} />
          )) : <Empty>No game code products.</Empty>}
        </Section>
        <Section title="Batches" count={batches.length}>
          {batches.length ? batches.map(b => (
            <Row key={b.id} wrap title={b.tag} detail={b.id + ' · ' + b.total + ' codes · ' + b.pending + ' pending · ' + b.sold + ' sold'}
              trail={(
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" size="sm" variant="outline" data-batch-edit={b.id} onClick={() => openers.editBatch(b.id)}>Rename</Button>
                  <DeleteButton label="Delete" what={'batch ' + b.id + ' and all its codes'} action="deleteBatch" payload={{ codeBatch: b.id }} attr={{ 'data-batch-del': b.id }} />
                </div>
              )} />
          )) : <Empty>No batches yet.</Empty>}
        </Section>
      </Stack>
    </SheetShell>
  );
}

export function EditBatchSheet({ id }) {
  const { lookups: L } = useApp();
  const b = (L.batches || []).find(x => x.id === id);
  const [tag, setTag] = useState(b ? b.tag : '');
  const { save, busy, error } = useSaver('editBatch', () => ({ codeBatch: id, tag }), { keepParent: true });
  if (!b) return <SheetShell title="Rename batch"><Hint>This batch no longer exists.</Hint></SheetShell>;
  return (
    <SheetShell title="Rename batch" description="Change a batch tag" footer={<Footer error={error} busy={busy} onSave={save}>Save</Footer>}>
      <Field label="Batch tag" id="bTag"><Input id="bTag" value={tag} onChange={e => setTag(e.target.value)} /></Field>
    </SheetShell>
  );
}

export function AddBatchSheet() {
  const { lookups: L } = useApp();
  const prods = L.products.filter(p => p.deliversAs === 'code');
  const [prod, setProd] = useState(prods[0] ? prods[0].id : '');
  const [qty, setQty] = useState('5');
  const [tag, setTag] = useState('');
  const { save, busy, error } = useSaver('addCodesBatch', () => ({ productId: prod, quantity: Number(qty) || 1, codeBatch: tag }), { keepParent: true });
  return (
    <SheetShell title="Create on-demand batch" description="Make pending code placeholders" footer={<Footer error={error} busy={busy} onSave={save}>Generate batch</Footer>}>
      <Stack>
        <Field label="Product" id="bProd"><NativeSelect id="bProd" value={prod} onChange={e => setProd(e.target.value)}><Options list={prods.map(p => ({ value: p.id, label: p.name }))} /></NativeSelect></Field>
        <Two>
          <Field label="Quantity (placeholders)" id="bQty"><Input id="bQty" inputMode="numeric" value={qty} onChange={e => setQty(e.target.value)} /></Field>
          <Field label="Batch / supplier tag" id="bTag"><Input id="bTag" placeholder="e.g. Bybit-Oct26" value={tag} onChange={e => setTag(e.target.value)} /></Field>
        </Two>
        <Hint>Creates pending placeholders for on-demand fulfillment.</Hint>
      </Stack>
    </SheetShell>
  );
}

export function CodesSheet() {
  const { lookups: L } = useApp();
  const prods = L.products.filter(p => p.deliversAs === 'code');
  const [prod, setProd] = useState(prods[0] ? prods[0].id : '');
  const [codes, setCodes] = useState('');
  const { save, busy, error } = useSaver('addCodes', () => ({ productId: prod, codes: codes.split(/\r?\n/) }), { keepParent: true });
  return (
    <SheetShell title="Game codes" description="Add codes to stock" footer={<Footer error={error} busy={busy} onSave={save}>Add codes</Footer>}>
      <Stack>
        <Section title="In stock">
          {prods.map(p => <Row key={p.id} title={p.name} trail={<span className="money text-sm font-semibold">{L.codes.filter(c => c.productId === p.id).length + ' in stock'}</span>} />)}
        </Section>
        <Field label="Add codes to" id="cProd"><NativeSelect id="cProd" value={prod} onChange={e => setProd(e.target.value)}><Options list={prods.map(p => ({ value: p.id, label: p.name }))} /></NativeSelect></Field>
        <Field label="Codes, one per line" id="cCodes"><Textarea id="cCodes" rows={6} className="font-mono" value={codes} onChange={e => setCodes(e.target.value)} /></Field>
      </Stack>
    </SheetShell>
  );
}

// ── Edit, retire and reactivate an account ───────────────────────────
export function EditAccountSheet({ account: a }) {
  useHoldRefresh();
  const [label, setLabel] = useState(a.label);
  const [cost, setCost] = useState(String(a.cost));
  const [slots, setSlots] = useState(String(a.rawSlots));
  const [till, setTill] = useState(a.renewalDate || '');
  const [notes, setNotes] = useState(a.notes || '');
  const [status, setStatus] = useState(a.status);
  const { save, busy, error } = useSaver('edit', () => {
    const values = {};
    if (label.trim() !== a.label) values.Account_Label = label.trim();
    if (num(cost, 'Cost') !== a.cost) values.Cycle_Cost = num(cost, 'Cost');
    if (num(slots, 'Seats') !== a.rawSlots) values.Slots = num(slots, 'Seats');
    if (till !== (a.renewalDate || '')) values.Renewal_Date = till;
    if (notes.trim() !== (a.notes || '').trim()) values.Notes = notes.trim();
    if (status !== a.status) values.Account_Status = status;
    if (!Object.keys(values).length) throw new Error('Nothing changed.');
    return { kind: 'account', id: a.id, values };
  }, { keepParent: true });
  const del = useSaver('deleteAccount', () => ({ accountId: a.id }), { keepParent: false });
  return (
    <SheetShell title={'Edit ' + a.id} description="Change an account's name, cost, seats, renewal date and status" footer={<Footer error={error || del.error} busy={busy || del.busy} onSave={save}>Save changes</Footer>}>
      <Stack>
        <Field label="Account name or login" id="acLabel" hint="The email or username you log in with. Never the password."><Input id="acLabel" autoComplete="off" value={label} onChange={e => setLabel(e.target.value)} /></Field>
        <Two>
          <Field label="Cost per cycle" id="acCost"><Input id="acCost" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} /></Field>
          <Field label="Seats" id="acSlots"><Input id="acSlots" inputMode="numeric" value={slots} onChange={e => setSlots(e.target.value)} /></Field>
        </Two>
        <Two>
          <Field label="Renews on" id="acTill"><Input id="acTill" type="date" value={till} onChange={e => setTill(e.target.value)} /></Field>
          <Field label="Status" id="acStatus">
            <NativeSelect id="acStatus" value={status} onChange={e => setStatus(e.target.value)}><Options list={['Active', 'Inactive', 'Banned', 'Closed']} /></NativeSelect>
          </Field>
        </Two>
        <Field label="Notes" id="acNotes"><Textarea id="acNotes" rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        <Hint>To take an account out of service and keep its profit in the right month, use Retire on the account card instead of changing the status here.</Hint>
        <div className="grid gap-2 border-t border-border pt-4">
          <ConfirmButton id="deleteKeep" label="Delete (keep the money)" icon={Trash2} className="text-bad hover:text-bad" title={'Delete ' + a.id + '?'}
            confirmLabel="Delete account"
            description="Its sales, purchases and profit stay in your totals, and the account disappears from every list. It is refused while any customer still has paid time left on it; end or move those lines first. You can undo this right after from the toast."
            onConfirm={del.save} />
          <Hint>Use this for an account made by mistake or no longer wanted. Unlike Retire, it does not stay in the Retired list.</Hint>
        </div>
      </Stack>
    </SheetShell>
  );
}

export function RetireAccountSheet({ account: a }) {
  const { today } = useApp();
  const [date, setDate] = useState(a.lastActive && a.lastActive < today ? a.lastActive : today);
  const [move, setMove] = useState(true);
  const { save, busy, error } = useSaver('retireAccount', () => ({ accountId: a.id, date, moveEntries: move }), { keepParent: false });
  return (
    <SheetShell title={'Retire ' + a.id} description="Take an account out of service and keep its profit on record"
      footer={<Footer error={error} busy={busy} onSave={save}>Retire account</Footer>}>
      <Stack>
        <div className="rounded-xl border border-border bg-card/60 p-4">
          <div className="font-mono text-sm font-bold break-all">{a.label}</div>
          <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
            <div><div className="text-xs text-muted-foreground">Collected</div><div className="money font-semibold">{tk(a.collected)}</div></div>
            <div><div className="text-xs text-muted-foreground">Cost</div><div className="money font-semibold">{tk(a.cost)}</div></div>
            <div><div className="text-xs text-muted-foreground">Net</div><div className={'money font-semibold ' + (a.net >= 0 ? 'text-ok' : 'text-bad')}>{tk(a.net)}</div></div>
          </div>
        </div>
        <Field label="Last day it was in use" id="retDate" hint="Its profit shows in the Book for this month.">
          <Input id="retDate" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <label className="flex items-start gap-3 text-sm" htmlFor="retMove">
          <input id="retMove" type="checkbox" className="mt-1 size-4 accent-[var(--primary)]" checked={move} onChange={e => setMove(e.target.checked)} />
          <span>Move its undated receipts and any cost entries after that day onto it, so the profit lands in that month.</span>
        </label>
        <Hint>Nothing is deleted. Its sales, payments and customers stay, and it moves to the Retired list with its totals. Undo is on the toast. You can reactivate it later from the Retired list.</Hint>
      </Stack>
    </SheetShell>
  );
}
