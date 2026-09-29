import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Waves } from 'lucide-react';
import { api } from '../lib/api';
import { useStore, type SessionUser } from '../store';
import { Button } from '../components/ui';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setUser = useStore((s) => s.setUser);
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const u = await api<SessionUser>('/api/auth/login', { body: { username, password } });
      setUser(u);
      nav(u.role === 'field' ? '/field' : '/');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-panel border border-line rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2"><Waves className="w-6 h-6 text-accent" aria-hidden /><div><h1 className="font-semibold">Kolhapur Flood Response</h1><p className="text-xs text-ink-3">Flood warning and response coordination prototype</p></div></div>
        <label className="block text-sm">Username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full bg-panel-2 border border-line rounded px-2 py-2" required /></label>
        <label className="block text-sm">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full bg-panel-2 border border-line rounded px-2 py-2" required /></label>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="text-xs text-ink-3 text-center"><a className="underline" href="/public">Public flood status and reporting (no login)</a></p>
      </form>
    </div>
  );
}
