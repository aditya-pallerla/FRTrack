/**
 * Warning versioning: a warning is never silently changed. A new version is created when the level,
 * the verification request, or the evidence materially changes, with a generated reason.
 */
import type { EvidenceItem, SettlementWarning } from '../../../shared/types.js';
import { levelRank } from './levels.js';

const RISK_STEP = 10;
const CONF_STEP = 0.15;

export function versionWarning(prev: SettlementWarning | null, cur: SettlementWarning): SettlementWarning {
  if (!prev) {
    return cur.level === 'NONE'
      ? { ...cur, version: 0, reason_for_change: null }
      : { ...cur, version: 1, reason_for_change: `Issued at ${cur.level}: ${supportingSummary(cur.evidence)}` };
  }
  const reasons: string[] = [];
  if (cur.level !== prev.level) {
    const dir = levelRank(cur.level) > levelRank(prev.level) ? 'Escalated' : 'Downgraded';
    reasons.push(`${dir} ${prev.level} → ${cur.level}`);
  }
  reasons.push(...evidenceDiff(prev.evidence, cur.evidence));
  if (cur.verification_requested && !prev.verification_requested) reasons.push('verification requested');
  const material = cur.level !== prev.level
    || Math.abs(cur.risk - prev.risk) >= RISK_STEP
    || Math.abs(cur.confidence.value - prev.confidence.value) >= CONF_STEP
    || cur.verification_requested !== prev.verification_requested;
  if (!material) return { ...cur, version: prev.version, reason_for_change: prev.reason_for_change };
  return { ...cur, version: prev.version + 1, reason_for_change: reasons.join('; ') || `risk ${prev.risk} → ${cur.risk}, confidence ${pct(prev.confidence.value)} → ${pct(cur.confidence.value)}` };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function supportingSummary(ev: EvidenceItem[]): string {
  const s = ev.filter((e) => e.supports && e.kind !== 'rain_trend').map((e) => e.label);
  return s.length ? s.join(', ') : 'environmental conditions';
}

function evidenceDiff(a: EvidenceItem[], b: EvidenceItem[]): string[] {
  const out: string[] = [];
  const key = (e: EvidenceItem) => `${e.kind}|${e.kind === 'road_blocked' ? e.label : ''}`;
  const before = new Map(a.map((e) => [key(e), e]));
  const after = new Map(b.map((e) => [key(e), e]));
  for (const [k, e] of after) {
    if (e.kind === 'rain_trend') continue; // context only; it has no threshold
    const old = before.get(k);
    if (!old) { if (e.supports) out.push(`new evidence: ${e.label}`); continue; }
    if (e.supports && !old.supports) out.push(`${e.label} crossed its threshold (${fmt(e)})`);
    if (!e.supports && old.supports) out.push(`${e.label} fell below its threshold (${fmt(e)})`);
    if (e.stale && !old.stale) out.push(`${e.label} became stale`);
    // Ground evidence can strengthen without crossing a threshold (e.g. a coordinator verifies a report).
    if ((e.kind === 'ground_support' || e.kind === 'ground_conflict') && typeof e.value === 'number' && typeof old.value === 'number'
      && Math.abs(e.value - old.value) >= 0.2) {
      out.push(`${e.kind === 'ground_support' ? 'ground evidence' : 'conflicting evidence'} ${e.value > old.value ? 'strengthened' : 'weakened'} (${old.value} → ${e.value}; ${e.source})`);
    }
  }
  for (const [k, e] of before) if (!after.has(k) && e.supports) out.push(`evidence no longer present: ${e.label}`);
  return out;
}

const fmt = (e: EvidenceItem) => `${e.value}${e.unit ? ` ${e.unit}` : ''}`;
