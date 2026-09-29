import { FloodMap } from '../components/FloodMap';
import { Overview } from '../components/Overview';
import { PriorityList } from '../components/PriorityList';
import { ReplayBar } from '../components/ReplayBar';
import { SettlementDetail } from '../components/SettlementDetail';
import { Shell } from '../components/Shell';
import { useStore } from '../store';

export function CommandCentre() {
  const selected = useStore((s) => s.selected);
  const ready = useStore((s) => !!s.geo && !!s.situation);
  return (
    <Shell footer={<ReplayBar />}>
      {!ready ? (
        <div className="h-full grid place-items-center text-ink-3">Loading Kolhapur flood situation…</div>
      ) : (
        <div className="h-full grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_400px]">
          <aside className="hidden lg:flex flex-col min-h-0 border-r border-line bg-panel" aria-label="Response priority"><PriorityList /></aside>
          <div className="min-h-[50vh] lg:min-h-0"><FloodMap /></div>
          <aside className="min-h-0 overflow-y-auto scroll-thin border-l border-line bg-panel" aria-label={selected ? 'Settlement details' : 'Overview'}>
            {selected ? <SettlementDetail id={selected} /> : <Overview />}
          </aside>
        </div>
      )}
    </Shell>
  );
}
