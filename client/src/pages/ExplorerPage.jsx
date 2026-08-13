import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import SearchBox from '../components/SearchBox.jsx';
import Badge from '../components/Badge.jsx';
import NeighborhoodGraph from '../components/NeighborhoodGraph.jsx';
import { Loading, ErrorState, EmptyState } from '../components/States.jsx';

// Human phrasing for property keys shown on the entity card.
const PROPERTY_LABELS = {
  category: 'Category', difficulty: 'Difficulty', type: 'Type', field: 'Field',
  level: 'Level', avgSalaryUSD: 'Avg. salary (US)', provider: 'Provider', industry: 'Industry',
};

export default function ExplorerPage() {
  const { label, name } = useParams(); // react-router decodes %2F etc.
  const navigate = useNavigate();
  const selected = Boolean(label && name);

  const entity = useApi(() => api.entity(label, name), [label, name], { enabled: selected });
  const rels = useApi(() => api.relationships(label, name), [label, name], { enabled: selected });

  const open = (target) =>
    navigate(`/explorer/${encodeURIComponent(target.label)}/${encodeURIComponent(target.name)}`);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Explorer</h1>
        <p className="mt-1 text-slate-400">Understand an entity and everything connected to it.</p>
      </header>
      <SearchBox placeholder="Search for a skill, technology, job, company or course…" autoFocus={!selected} />

      {!selected && (
        <EmptyState
          title="Search to get started"
          hint='Try "Python", "PyTorch" or "ML Engineer".'
        />
      )}

      {selected && entity.loading && <Loading label={`Loading ${name}…`} />}
      {selected && entity.error && <ErrorState error={entity.error} onRetry={entity.retry} />}
      {selected && entity.data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="space-y-6">
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">{entity.data.properties.name}</h2>
                <Badge label={entity.data.label} />
              </div>
              <p className="mt-2 text-slate-400">{entity.data.properties.description}</p>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {Object.entries(entity.data.properties)
                  .filter(([key]) => PROPERTY_LABELS[key])
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-slate-500">{PROPERTY_LABELS[key]}</dt>
                      <dd className="text-slate-200">
                        {key === 'avgSalaryUSD' ? `$${Number(value).toLocaleString('en-US')}` : String(value)}
                      </dd>
                    </div>
                  ))}
              </dl>
              {entity.data.properties.url && (
                <a
                  href={entity.data.properties.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block text-sm font-medium text-indigo-300 hover:text-indigo-200"
                >
                  Visit course page ↗
                </a>
              )}
            </section>

            <section aria-label="Relationships" className="space-y-4">
              {rels.loading && <Loading label="Loading relationships…" />}
              {rels.error && <ErrorState error={rels.error} onRetry={rels.retry} />}
              {rels.data && rels.data.relationships.length === 0 && (
                <EmptyState title="No relationships" hint="This entity is not connected to anything yet." />
              )}
              {rels.data?.relationships.map((group) => (
                <div key={`${group.type}-${group.direction}`} className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                  <h3 className="text-sm font-semibold tracking-wide text-slate-400">
                    {group.direction === 'outgoing' ? `${group.type} →` : `← ${group.type}`}
                    <span className="ml-2 font-normal text-slate-500">
                      {group.direction === 'outgoing' ? 'from this entity' : 'pointing at this entity'}
                    </span>
                  </h3>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {group.entities.map((other) => (
                      <li key={`${other.label}:${other.name}`}>
                        <button
                          type="button"
                          onClick={() => open(other)}
                          title={other.description}
                          className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-1.5 text-sm text-slate-200 hover:border-indigo-500/50 focus-visible:border-indigo-400 focus-visible:outline-none"
                        >
                          <Badge label={other.label} />
                          {other.name}
                          {other.relationship?.level && (
                            <span className="text-xs text-slate-500">({other.relationship.level})</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          </div>

          <section aria-label="Neighborhood graph" className="rounded-2xl border border-slate-800 bg-slate-900 p-4 lg:sticky lg:top-6 lg:self-start">
            <p className="px-2 pb-2 text-sm text-slate-500">
              One hop around <span className="text-slate-300">{entity.data.properties.name}</span> — arrows show the
              stored direction; click any node to re-center.
            </p>
            {rels.data && rels.data.relationships.length > 0 ? (
              <NeighborhoodGraph
                center={{ label: entity.data.label, name: entity.data.properties.name }}
                groups={rels.data.relationships}
                onSelect={open}
              />
            ) : (
              !rels.loading && <EmptyState title="Nothing to draw" />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
