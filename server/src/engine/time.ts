/** Time helpers. All engine logic works on epoch milliseconds; display is always IST. */

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const ms = (iso: string) => new Date(iso).getTime();

export function ageMin(observedAt: string | null, now: number): number | null {
  if (!observedAt) return null;
  return Math.max(0, Math.round((now - ms(observedAt)) / MIN));
}

/** ISO string in IST (+05:30), so replayed timestamps keep their original local time. */
export function toIstIso(t: number): string {
  const d = new Date(t + 5.5 * HOUR);
  return d.toISOString().replace('Z', '+05:30');
}

const IST_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** "22 Jul 2021, 14:00 IST" */
export function formatIst(t: number | string): string {
  return `${IST_FMT.format(new Date(t))} IST`;
}
