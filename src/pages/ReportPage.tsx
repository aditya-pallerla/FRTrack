import { useState } from 'react';
import type { ReportEvidence } from '../../shared/types';
import { ReportForm } from '../components/ReportForm';
import { Shell } from '../components/Shell';
import { Panel, SectionTitle, Tag } from '../components/ui';

/** Staff intake: same form as the public page, but shows what the extractor understood. */
export function ReportPage() {
  const [last, setLast] = useState<{ report: { evidence: ReportEvidence }; extraction: { model: string | null; fallback_reason: string | null } } | null>(null);
  return (
    <Shell>
      <div className="h-full overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto grid gap-4">
          <Panel className="p-4"><SectionTitle>New ground report</SectionTitle><ReportForm endpoint="/api/reports" onDone={(r) => setLast(r as typeof last)} /></Panel>
          {last && (
            <Panel className="p-4 text-sm space-y-1">
              <SectionTitle>What the system extracted</SectionTitle>
              <p>Evidence: {last.report.evidence.kinds.join(', ') || 'nothing recognised'}</p>
              <p>Road blocked: {last.report.evidence.road_blocked ? 'yes' : 'no'} · trapped: {last.report.evidence.people_trapped === -1 ? 'yes (count unknown)' : last.report.evidence.people_trapped} · vulnerable people: {last.report.evidence.vulnerable_present ? 'yes' : 'no'}</p>
              <p className="flex items-center gap-2">Extractor: <Tag>{last.extraction.model ?? 'keyword fallback'}</Tag>{last.extraction.fallback_reason && <span className="text-xs text-ink-3">{last.extraction.fallback_reason}</span>}</p>
              <p className="text-xs text-ink-3">The extractor only reads the text. The warning level and priority are decided by the transparent engine, and one unverified report can never raise a SEVERE warning.</p>
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}
