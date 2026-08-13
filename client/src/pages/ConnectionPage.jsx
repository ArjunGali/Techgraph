import { useState } from 'react';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import EntityPicker from '../components/EntityPicker.jsx';
import PathDiagram from '../components/PathDiagram.jsx';
import { Loading, ErrorState, EmptyState } from '../components/States.jsx';

// Connection Explorer: how are two specific entities connected? Endpoints
// are chosen as explicit (label, name) pairs; the backend returns each hop
// with its true stored direction (from → to), which the diagram and the
// sentence list below both honor.
export default function ConnectionPage() {
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [query, setQuery] = useState(null); // the pair actually submitted

  const result = useApi(
    () => api.connectionPath(query.from, query.to),
    [query],
    { enabled: Boolean(query) },
  );

  const same = from && to && from.label === to.label && from.name === to.name;
  const ready = from && to && !same;
  const path = result.data?.path;

  // Direction truth per hop: the API says which node each edge starts from.
  const edges = path
    ? path.relationships.map((rel, i) => ({
        label: rel.type,
        direction: rel.from === path.nodes[i].name ? 'forward' : 'backward',
      }))
    : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Connection Explorer</h1>
        <p className="mt-1 text-slate-400">
          Answers one question: <span className="text-slate-200">how are these two things connected?</span>{' '}
          Pick any two — a skill and a company, a course and a job — and the shortest route between
          them is found live, whatever it has to cross to get there. (Looking for career advice?
          That's the Career Path tool.)
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr_auto]">
          <EntityPicker id="conn-from" title="From" value={from} onChange={setFrom} />
          <button
            type="button"
            onClick={() => { setFrom(to); setTo(from); }}
            aria-label="Swap endpoints"
            className="self-end rounded-lg border border-slate-700 px-3 py-2.5 text-slate-300 hover:border-indigo-500/50 focus-visible:border-indigo-400 focus-visible:outline-none"
          >
            ⇄
          </button>
          <EntityPicker id="conn-to" title="To" value={to} onChange={setTo} />
          <button
            type="button"
            disabled={!ready}
            onClick={() => setQuery({ from, to })}
            className="self-end rounded-lg bg-indigo-500 px-5 py-2.5 font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300"
          >
            Find connection
          </button>
        </div>
        {same && <p className="mt-3 text-sm text-amber-300">Choose two different entities to connect.</p>}
      </section>

      {!query && (
        <EmptyState
          title="Choose a starting point and a destination"
          hint='Try connecting the skill "Git" to the company "Google".'
        />
      )}

      {query && result.loading && (
        <Loading label={`Finding a route from ${query.from.name} to ${query.to.name}…`} />
      )}
      {query && result.error && <ErrorState error={result.error} onRetry={result.retry} />}

      {query && result.data && path === null && (
        <EmptyState
          title={`No connection found between ${query.from.name} and ${query.to.name}`}
          hint="These entities are not linked within 6 hops of each other."
        />
      )}

      {query && path && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-label="Connection found">
          <p className="text-sm text-slate-400">
            Connected in <span className="font-medium text-slate-200">{path.relationships.length} hops</span> —
            arrowheads show the direction each relationship is actually stored in.
          </p>
          <div className="pt-4">
            <PathDiagram nodes={path.nodes} edges={edges} />
          </div>
          <ul className="mt-4 space-y-1.5 border-t border-slate-800 pt-4">
            {path.relationships.map((rel, i) => (
              <li key={i} className="text-sm text-slate-400">
                <span className="text-slate-200">{rel.from}</span>
                <span className="mx-1.5 text-indigo-300">—{rel.type}→</span>
                <span className="text-slate-200">{rel.to}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
