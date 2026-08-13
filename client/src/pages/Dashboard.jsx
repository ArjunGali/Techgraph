import { Link } from 'react-router-dom';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { LABEL_STYLES } from '../utils/labels.js';
import SearchBox from '../components/SearchBox.jsx';
import { Loading, ErrorState } from '../components/States.jsx';

const TOOLS = [
  { to: '/path-builder', name: 'Path Builder', text: 'Your skills + a target job → gaps, route and study plan.' },
  { to: '/explorer', name: 'Explorer', text: 'Understand any entity and everything connected to it.' },
  { to: '/career-path', name: 'Career Path', text: 'Discover routes from a skill you have toward real careers.' },
  { to: '/study-path', name: 'Study Path', text: 'Turn a skill into next technologies and courses to learn.' },
  { to: '/connections', name: 'Connection Explorer', text: 'Find how any two things in the graph are connected.' },
];

export default function Dashboard() {
  const stats = useApi(() => api.stats(), []);

  return (
    <div className="space-y-10">
      <section className="mx-auto max-w-2xl pt-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          Explore tech careers as a <span className="text-indigo-400">graph</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-slate-400">
          Skills, technologies, jobs, companies and courses — connected the way they are in the
          real world. Every answer below is a live traversal, not a lookup table.
        </p>
        <div className="mt-6 text-left">
          <SearchBox autoFocus />
        </div>
      </section>

      <section aria-label="Graph statistics">
        {stats.loading && <Loading label="Loading graph statistics…" />}
        {stats.error && <ErrorState error={stats.error} onRetry={stats.retry} />}
        {stats.data && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm text-slate-500">Skills, jobs & more</p>
              <p className="mt-1 text-3xl font-bold">{stats.data.totalNodes}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm text-slate-500">Relationships between them</p>
              <p className="mt-1 text-3xl font-bold">{stats.data.totalRelationships}</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm text-slate-500">By type</p>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(stats.data.nodesByLabel).map(([label, count]) => (
                  <li key={label} className="flex items-center gap-1.5 text-sm text-slate-300">
                    <span className="h-2 w-2 rounded-full" style={{ background: LABEL_STYLES[label]?.dot }} aria-hidden="true" />
                    {label} <span className="text-slate-500">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm text-slate-500">Most-required skills</p>
              <ul className="mt-2 space-y-1.5">
                {stats.data.topRequiredSkills.slice(0, 4).map((row) => (
                  <li key={row.skill} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-300">{row.skill}</span>
                    <span className="text-slate-500">{row.jobs} jobs</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      <section aria-label="Tools" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link
            key={tool.to}
            to={tool.to}
            className="group rounded-2xl border border-slate-800 bg-slate-900 p-5 transition-colors hover:border-indigo-500/50 focus-visible:border-indigo-400 focus-visible:outline-none"
          >
            <p className="font-semibold text-slate-100 group-hover:text-indigo-300">{tool.name} →</p>
            <p className="mt-1 text-sm text-slate-400">{tool.text}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
