import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import EntityPicker from '../components/EntityPicker.jsx';
import Badge from '../components/Badge.jsx';
import { Loading, ErrorState, EmptyState } from '../components/States.jsx';

// Study Path: from a skill you have, which technologies become reachable,
// and which courses teach them. Technologies with no seeded course render an
// intentional per-card empty state rather than being hidden.
export default function StudyPathPage() {
  const [skill, setSkill] = useState(null);
  const study = useApi(() => api.studyPath(skill.name), [skill?.name], { enabled: Boolean(skill) });

  const technologies = study.data?.technologies ?? [];
  const withCourses = technologies.filter((t) => t.courses.length > 0).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Study Path</h1>
        <p className="mt-1 text-slate-400">
          Turn a skill you have into a concrete next step: the technologies that build on it, and
          the courses that teach them.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="max-w-md">
          <EntityPicker
            id="study-skill"
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
          hint='Try "Python" to see which technologies open up next.'
        />
      )}

      {skill && study.loading && <Loading label={`Finding what to learn after ${skill.name}…`} />}
      {skill && study.error && <ErrorState error={study.error} onRetry={study.retry} />}

      {skill && study.data && technologies.length === 0 && (
        <EmptyState
          title={`Nothing builds on ${skill.name} yet`}
          hint="No technology in the graph lists this skill as a prerequisite."
        />
      )}

      {skill && technologies.length > 0 && (
        <>
          <p className="text-sm text-slate-400">
            <span className="font-medium text-slate-200">{technologies.length} technologies</span> are
            within reach from {skill.name} — {withCourses} have a course in the graph.
          </p>
          <section className="grid gap-4 md:grid-cols-2" aria-label="Reachable technologies">
            {technologies.map((tech) => (
              <article key={tech.technology} className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-slate-100">{tech.technology}</h2>
                  <Badge label="Technology" />
                  <span className="text-xs text-slate-500">{tech.type}</span>
                </div>
                <p className="mt-1.5 flex-1 text-sm text-slate-400">{tech.description}</p>

                <div className="mt-4 border-t border-slate-800 pt-4">
                  {tech.courses.length > 0 ? (
                    <ul className="space-y-2">
                      {tech.courses.map((course) => (
                        <li key={course.name}>
                          <a
                            href={course.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2 hover:border-violet-500/50 focus-visible:border-violet-400 focus-visible:outline-none"
                          >
                            <span className="block text-sm font-medium text-slate-100">{course.name} ↗</span>
                            <span className="block text-xs text-slate-500">
                              {course.provider} · {course.level}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-500">
                      No course in the graph teaches this yet.
                    </p>
                  )}
                </div>

                <Link
                  to={`/explorer/Technology/${encodeURIComponent(tech.technology)}`}
                  className="mt-3 text-sm font-medium text-indigo-300 hover:text-indigo-200"
                >
                  Explore {tech.technology} →
                </Link>
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
