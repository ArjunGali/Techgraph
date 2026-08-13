import { useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { useApi } from './hooks/useApi.js';
import { healthStatus } from './services/api.js';
import Dashboard from './pages/Dashboard.jsx';
import ExplorerPage from './pages/ExplorerPage.jsx';
import CareerPathPage from './pages/CareerPathPage.jsx';
import StudyPathPage from './pages/StudyPathPage.jsx';
import ConnectionPage from './pages/ConnectionPage.jsx';
import PathBuilderPage from './pages/PathBuilderPage.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/explorer', label: 'Explorer' },
  { to: '/career-path', label: 'Career Path' },
  { to: '/study-path', label: 'Study Path' },
  { to: '/connections', label: 'Connection Explorer' },
  { to: '/path-builder', label: 'Path Builder' },
];

function HealthDot() {
  const health = useApi(() => healthStatus(), []);
  // Re-check every 30s so the dot recovers after an outage without a reload.
  useEffect(() => {
    const timer = setInterval(health.retry, 30_000);
    return () => clearInterval(timer);
  }, [health.retry]);
  if (!health.data) return null;
  const online = health.data.online;
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-slate-500"
      title={`Database: ${health.data.database}`}
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-rose-400'}`} aria-hidden="true" />
      {online ? 'Graph online' : 'Database offline'}
    </span>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800/80 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4">
          <NavLink to="/" className="flex items-center gap-2" aria-label="TechGraph home">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 font-bold">T</span>
            <span className="text-lg font-bold tracking-tight">
              Tech<span className="text-indigo-400">Graph</span>
            </span>
          </NavLink>
          <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${
                    isActive ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <HealthDot />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/explorer" element={<ExplorerPage />} />
          <Route path="/explorer/:label/:name" element={<ExplorerPage />} />
          <Route path="/career-path" element={<CareerPathPage />} />
          <Route path="/study-path" element={<StudyPathPage />} />
          <Route path="/connections" element={<ConnectionPage />} />
          <Route path="/path-builder" element={<PathBuilderPage />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-slate-600">
        TechGraph — every answer on this site is a live graph traversal in CognoDB.
      </footer>
    </div>
  );
}
