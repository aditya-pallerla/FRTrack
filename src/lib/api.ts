/** Thin fetch wrapper: JSON in/out, cookies included, server error messages surfaced as Error.message. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  // Session expired or server restarted with a new secret: go back to sign-in instead of failing silently.
  if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/public/') && location.pathname !== '/public') {
    location.assign('/login');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? (res.status === 401 ? 'Please sign in again' : `Request failed (${res.status})`));
  return data as T;
}
