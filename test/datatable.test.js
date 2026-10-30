// web/src/components/DataTable.jsx (uplift plan 3.1): static markup through Vite's SSR loader, because the component is JSX.
// Interactive behaviour (sort clicks, selection count, keyboard, virtualised rows) is covered by the UI tests in task 3.2.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');

const COLUMNS = [
  { accessorKey: 'name', header: 'Name', meta: { width: 'w-48' } },
  { accessorKey: 'phone', header: 'Phone', enableSorting: false, meta: { mono: true } },
  { accessorKey: 'paid', header: 'Paid', meta: { align: 'right', mono: true } },
  { accessorKey: 'note', header: 'Note', meta: { hideBelow: 'lg' } },
];
// Made-up people and numbers: no real customer data in tests.
const ROWS = [
  { id: 'C1', name: 'Test Alpha', phone: '01700000001', paid: 1200, note: 'vip' },
  { id: 'C2', name: 'Test Beta', phone: '01700000002', paid: 450, note: 'new' },
];
const byId = row => row.id;

describe('DataTable static markup', () => {
  let server;
  let DataTable;
  let createElement;
  let renderToStaticMarkup;

  before(async () => {
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: path.join(root, 'vite.config.mjs'),
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] }
    });
    ({ DataTable } = await server.ssrLoadModule('/src/components/DataTable.jsx'));
    ({ createElement } = require('react'));
    ({ renderToStaticMarkup } = require('react-dom/server'));
  });

  after(async () => {
    if (server) await server.close();
  });

  const render = props => renderToStaticMarkup(createElement(DataTable, { columns: COLUMNS, getRowId: byId, label: 'Customers', ...props }));
  const tags = (markup, tag) => markup.match(new RegExp(`<${tag}[\\s>][^>]*>`, 'g')) || [];

  test('renders the headers and one row per record', () => {
    const markup = render({ data: ROWS });
    assert.match(markup, /<table aria-label="Customers"/);
    assert.equal(tags(markup, 'tr').length, 1 + ROWS.length, 'one header row plus one per record');
    assert.match(markup, /<tbody data-cell-group="">/);
    for (const text of ['Test Alpha', 'Test Beta', '01700000001', '1200']) assert.ok(markup.includes(text), text);
  });

  test('sortable headers carry aria-sort="none"; a non-sortable header carries none', () => {
    const markup = render({ data: ROWS });
    const ths = tags(markup, 'th');
    assert.equal(ths.length, COLUMNS.length);
    assert.equal(ths.filter(t => t.includes('aria-sort="none"')).length, 3, 'Name, Paid and Note sort');
    const phone = ths.find((t, i) => i === 1);
    assert.ok(!phone.includes('aria-sort'), 'Phone is not sortable');
  });

  test('defaultSorting sets aria-sort and the row order', () => {
    const markup = render({ data: ROWS, defaultSorting: [{ id: 'paid', desc: false }] });
    const paid = tags(markup, 'th')[2];
    assert.ok(paid.includes('aria-sort="ascending"'), paid);
    assert.ok(markup.indexOf('Test Beta') < markup.indexOf('Test Alpha'), 'paid 450 before paid 1200');
  });

  test('a column hidden by defaultColumnVisibility is not rendered at all', () => {
    const markup = render({ data: ROWS, defaultColumnVisibility: { note: false } });
    assert.ok(!markup.includes('>Note<'), 'Note header absent');
    assert.ok(!markup.includes('>vip<') && !markup.includes('>new<'), 'Note cells absent');
    assert.equal(tags(markup, 'th').length, COLUMNS.length - 1);
  });

  test('hideBelow adds the breakpoint class to header and cells', () => {
    const markup = render({ data: ROWS });
    assert.equal(tags(markup, 'th').filter(t => t.includes('hidden lg:table-cell')).length, 1);
    assert.equal(tags(markup, 'td').filter(t => t.includes('hidden lg:table-cell')).length, ROWS.length);
  });

  test('numbers are right-aligned and mono in the body', () => {
    const markup = render({ data: ROWS });
    const paidCell = tags(markup, 'td').find(t => t.includes('text-right') && t.includes('money'));
    assert.ok(paidCell, 'a td with text-right and money');
    const paidHead = tags(markup, 'th')[2];
    assert.ok(paidHead.includes('text-right'), 'header aligns right too');
  });

  test('selectable renders a checkbox per row and one for all', () => {
    const markup = render({ data: ROWS, selectable: true, onSelectionChange: () => {} });
    assert.equal(markup.split('aria-label="Select row"').length - 1, ROWS.length);
    assert.equal(markup.split('aria-label="Select all"').length - 1, 1);
    assert.equal(markup.split('role="checkbox"').length - 1, ROWS.length + 1);
  });

  test('without selectable there are no checkboxes', () => {
    const markup = render({ data: ROWS });
    assert.ok(!markup.includes('role="checkbox"'));
  });

  test('only the first row is in the tab order (roving tabindex)', () => {
    const markup = render({ data: ROWS });
    const rows = tags(markup, 'tr').filter(t => t.includes('data-row-index'));
    assert.equal(rows.length, ROWS.length);
    assert.ok(rows[0].includes('tabindex="0"'), rows[0]);
    assert.ok(rows[1].includes('tabindex="-1"'), rows[1]);
  });

  test('empty data renders the empty node and no table', () => {
    const markup = render({ data: [], empty: createElement('p', null, 'No customers yet') });
    assert.ok(markup.includes('No customers yet'));
    assert.ok(!markup.includes('<table'));
  });

  test('empty data without an empty node shows the default line', () => {
    const markup = render({ data: [] });
    assert.ok(markup.includes('Nothing to show.'));
    assert.ok(!markup.includes('<table'));
  });
});
