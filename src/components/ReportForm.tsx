import { useEffect, useState, type FormEvent } from 'react';
import { LocateFixed } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui';

interface Props { endpoint: '/api/reports' | '/api/public/reports'; onDone?: (r: unknown) => void }

const SAMPLES = [
  'Water has entered houses near the school and the main road is blocked.',
  'पाणी घरात शिरलं आहे, शाळेजवळचा मुख्य रस्ता बंद आहे.',
  'पुल डूब गया है, लोग फंसे हुए हैं, नाव भेजो।',
];

/** Report form: GPS or a chosen village is required — a location is never guessed. */
export function ReportForm({ endpoint, onDone }: Props) {
  const [text, setText] = useState('');
  const [settlements, setSettlements] = useState<{ id: string; name: string; name_mr: string | null }[]>([]);
  const [settlementId, setSettlementId] = useState('');
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracy_m: number } | null>(null);
  const [gpsState, setGpsState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => { api<typeof settlements>('/api/public/settlements').then(setSettlements).catch(() => setSettlements([])); }, []);

  function locate() {
    if (!navigator.geolocation) { setGpsState('Location is not available in this browser.'); return; }
    setGpsState('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (p) => { setGps({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy }); setGpsState(`Location attached (±${Math.round(p.coords.accuracy)} m)`); },
      () => setGpsState('Could not get your location. Choose your village instead.'),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null);
    try {
      const body = { text, ...(gps ?? {}), ...(settlementId && !gps ? { settlement_id: settlementId } : {}) };
      const r = await api<Record<string, unknown>>(endpoint, { body });
      setResult('Report received. Thank you — it will be checked against other reports and conditions.');
      setText('');
      onDone?.(r);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm font-medium">What is happening?
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} required
          placeholder="Describe the flooding: water in homes, road or bridge under water, people trapped…"
          className="mt-1 w-full bg-panel-2 border border-line rounded px-2 py-2 text-sm" />
      </label>
      <div className="flex flex-wrap gap-1.5">
        {SAMPLES.map((s) => <button type="button" key={s} onClick={() => setText(s)} className="text-[11px] border border-line rounded px-2 py-1 text-ink-2 hover:border-line-strong text-left">{s}</button>)}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Where? (required)</legend>
        <Button type="button" onClick={locate} className="min-h-11"><LocateFixed className="w-4 h-4" />Attach my current location</Button>
        {gpsState && <p className="text-xs text-ink-2">{gpsState}</p>}
        {!gps && (
          <label className="block text-sm">…or choose your village / area
            <select value={settlementId} onChange={(e) => setSettlementId(e.target.value)} className="mt-1 w-full bg-panel-2 border border-line rounded px-2 py-2 text-sm">
              <option value="">Select…</option>
              {settlements.map((s) => <option key={s.id} value={s.id}>{s.name}{s.name_mr ? ` (${s.name_mr})` : ''}</option>)}
            </select>
          </label>
        )}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {result && <p role="status" className="text-sm text-emerald-300">{result}</p>}
      <Button type="submit" variant="primary" className="w-full min-h-11" disabled={busy || text.trim().length < 5 || (!gps && !settlementId)}>{busy ? 'Sending…' : 'Send report'}</Button>
    </form>
  );
}
