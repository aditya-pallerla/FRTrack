import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { WarningLevel } from '../../shared/types';
import { LEVEL_STYLE } from '../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('bg-panel border border-line rounded-lg', className)}>{children}</section>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{children}</h3>
      {right}
    </div>
  );
}

export function LevelBadge({ level, size = 'sm' }: { level: WarningLevel; size?: 'sm' | 'lg' }) {
  const s = LEVEL_STYLE[level];
  return (
    <span className={cx('inline-flex items-center border rounded font-semibold tracking-wide whitespace-nowrap', s.cls, size === 'lg' ? 'px-2.5 py-1 text-sm' : 'px-1.5 py-0.5 text-[11px]')}>
      {s.label}
    </span>
  );
}

export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'danger' | 'warn' | 'ok' | 'info' | 'synthetic'; title?: string }) {
  const tones = {
    neutral: 'bg-panel-2 text-ink-2 border-line', danger: 'bg-severe/15 text-red-300 border-severe/50',
    warn: 'bg-warning/15 text-amber-300 border-warning/50', ok: 'bg-live/10 text-emerald-300 border-live/40',
    info: 'bg-replay/15 text-blue-300 border-replay/50', synthetic: 'bg-synthetic/15 text-purple-300 border-synthetic/50',
  };
  return <span title={title} className={cx('inline-flex items-center gap-1 border rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap', tones[tone])}>{children}</span>;
}

export function Button({ variant = 'secondary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'; size?: 'sm' | 'md' }) {
  const v = {
    primary: 'bg-accent text-white hover:bg-blue-500 border-transparent', secondary: 'bg-panel-2 text-ink border-line-strong hover:border-accent',
    danger: 'bg-severe/20 text-red-200 border-severe/60 hover:bg-severe/30', ghost: 'bg-transparent text-ink-2 border-transparent hover:text-ink',
    success: 'bg-emerald-600 text-white border-transparent hover:bg-emerald-500',
  };
  return (
    <button
      {...p}
      className={cx('inline-flex items-center justify-center gap-1.5 border rounded-md font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm', v[variant], className)}
    />
  );
}

export function Meter({ value, label, tone }: { value: number; label: string; tone: 'risk' | 'confidence' }) {
  const pctv = Math.max(0, Math.min(100, value));
  const color = tone === 'risk' ? (pctv >= 70 ? '#ef4444' : pctv >= 40 ? '#f59e0b' : '#eab308') : '#4c9aff';
  return (
    <div>
      <div className="flex items-baseline justify-between"><span className="text-[11px] uppercase tracking-wider text-ink-3">{label}</span><span className="text-lg font-semibold tabular-nums">{tone === 'risk' ? `${Math.round(pctv)} / 100` : `${Math.round(pctv)}%`}</span></div>
      <div className="h-1.5 bg-panel-2 rounded mt-1" role="meter" aria-valuenow={Math.round(pctv)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded" style={{ width: `${pctv}%`, background: color }} />
      </div>
    </div>
  );
}
