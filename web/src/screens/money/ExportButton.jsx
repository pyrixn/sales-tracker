import { useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { call } from '@/lib/api';
import { saveText } from '@/lib/download';
import { Button } from '@/components/ui/button';

const NAMES = { overview: 'Overview', book: 'Book', cash: 'Cash' };

/** Asks the server for the tab's CSV (moneyExport) and saves it. `month` is optional (the server defaults to this month). */
export function ExportButton({ tab, month }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const r = await call('moneyExport', month ? { tab, month } : { tab });
    setBusy(false);
    if (!r.ok) { toast.error(r.error || 'Could not export.'); return; }
    saveText(r.data.filename, r.data.csv);
  };
  return (
    <Button type="button" variant="outline" className="h-11 font-bold" disabled={busy} aria-label={'Export ' + NAMES[tab] + ' as CSV'} onClick={run}>
      <Download />Export
    </Button>
  );
}
