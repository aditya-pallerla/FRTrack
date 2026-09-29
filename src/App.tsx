import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { connect, disconnect } from './lib/realtime';
import { CommandCentre } from './pages/CommandCentre';
import { FieldPage } from './pages/FieldPage';
import { Login } from './pages/Login';
import { PublicPage } from './pages/PublicPage';
import { ReportPage } from './pages/ReportPage';
import { useStore, type SessionUser } from './store';

function Guard({ roles, children }: { roles: SessionUser['role'][]; children: ReactNode }) {
  const user = useStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to={user.role === 'field' ? '/field' : '/'} replace />;
  return <>{children}</>;
}

export default function App() {
  const user = useStore((s) => s.user);
  const checked = useStore((s) => s.authChecked);
  useEffect(() => { void useStore.getState().checkSession(); }, []);
  useEffect(() => {
    if (!user) return;
    connect();
    void useStore.getState().loadStatic().catch((e) => useStore.getState().notify('error', (e as Error).message));
    return () => disconnect();
  }, [user]);

  if (!checked) return <div className="h-full grid place-items-center text-ink-3">Loading…</div>;
  return (
    <Routes>
      <Route path="/public" element={<PublicPage />} />
      <Route path="/login" element={user ? <Navigate to={user.role === 'field' ? '/field' : '/'} replace /> : <Login />} />
      <Route path="/" element={<Guard roles={['admin', 'coordinator']}><CommandCentre /></Guard>} />
      <Route path="/report" element={<Guard roles={['admin', 'coordinator', 'field']}><ReportPage /></Guard>} />
      <Route path="/field" element={<Guard roles={['admin', 'field']}><FieldPage /></Guard>} />
      <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
    </Routes>
  );
}
