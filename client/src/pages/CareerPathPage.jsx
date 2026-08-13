import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import EntityPicker from '../components/EntityPicker.jsx';
import PathDiagram from '../components/PathDiagram.jsx';
import Badge from '../components/Badge.jsx';
import { Loading, ErrorState, EmptyState } from '../components/States.jsx';

// Career Path: pick a skill you already have, and the graph discovers routes
// from it to real jobs. Every path drawn comes from /api/career-path — the
// showcase result (Python → Machine Learning → PyTorch → ML Engineer) is
// discovered by the traversal, never hard-coded here.
export default function CareerPathPage() {
  const [skill, setSkill] = useState(null);
  const paths = useApi(() => api.careerPath(skill.name), [skill?.name], { enabled: Boolean(skill) });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Career Path</h1>
        <p className="mt-1 text-slate-400">
          Start from a skill you already have. The graph walks forward through skills it leads to,
          into the technologies built on them, and out to the jobs that use those technologies.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="max-w-md">
          <EntityPicker
            id="career-skill"
            title="A skill you already have"
            fixedLabel="Skill"
            value={skill}
            onChange={setSkill}
          />
        </div>
      </section>

      {!skill && (
        <EmptyState
          title="Pick a skill to begin"
          hint='Try "Python", "SQL" or "JavaScript" to see where they lead.'
        />
      )}

      {skill && paths.loading && <Loading label={`Finding careers reachable from ${skill.name}…`} />}
      {skill && paths.error && <ErrorState error={paths.error} onRetry={paths.retry} />}

      {skill && paths.data && paths.data.paths.length === 0 && (
        <EmptyState
          title={`No career routes found from ${skill.name}`}
          hint="This skill has no onward connections in the graph yet. Try another starting skill."
        />
      )}

      {skill && paths.data && paths.data.paths.length > 0 && (
        <section className="space-y-4" aria-label="Discovered career paths">
          <p className="text-sm text-slate-400">
            <span className="font-medium text-slate-200">{paths.data.paths.length} routes</span> found
            from <span className="font-medium text-slate-200">{skill.name}</span>, reaching{' '}
            {new Set(paths.data.paths.map((p) => p.job)).size} different careers.
          </p>

          {paths.data.paths.map((path, index) => (
            <article
              key={`${path.job}-${index}`}
              className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-500">Leads to</span>
                  <span className="font-semibold text-slate-100">{path.job}</span>
                  <Badge label="Job" />
                </div>
                <Link
                  to={`/explorer/Job/${encodeURIComponent(path.job)}`}
                  className="text-sm font-medium text-indigo-300 hover:text-indigo-200"
                >
                  Explore this job →
                </Link>
              </div>

              {/* The graph path itself, visually distinct from the prose above. */}
              <div className="pt-4">
                <PathDiagram
                  nodes={path.steps}
                  edges={path.relationshipTypes.map((type) => ({ label: type, direction: 'forward' }))}
                />
              </div>

              <p className="mt-2 text-center text-xs text-slate-500">
                Arrows show your learning order, not storage direction. The labels are the real
                stored edges ({path.relationshipTypes.join(', ')}) — REQUIRES and USES point the
                opposite way in the graph and are traversed in reverse here.
              </p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
