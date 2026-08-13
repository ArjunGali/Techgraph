import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import EntityPicker from '../components/EntityPicker.jsx';
import PathDiagram from '../components/PathDiagram.jsx';
import Badge from '../components/Badge.jsx';
import { Loading, ErrorState, EmptyState } from '../components/States.jsx';

// Career/Learning Path Builder: "I know these skills and want this job —
// what am I missing, how do I get there, what can I study?" Every section
// below renders the composite /api/career-builder response; nothing is
// computed or invented client-side.

function SkillChip({ name, tone, onRemove }) {
  const tones = {
    have: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    core: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
    nice: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    plain: 'border-slate-600 bg-slate-800 text-slate-200',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${tones[tone]}`}>
      {name}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="rounded-full px-1 leading-none hover:bg-white/10 focus-visible:outline focus-visible:outline-1"
        >
          ×
        </button>
      )}
    </span>
  );
}

const FlowArrow = () => (
  <div aria-hidden="true" className="text-center text-lg text-slate-600">↓</div>
);

export default function PathBuilderPage() {
  const [skills, setSkills] = useState([]); // [{label:'Skill', name}]
  const [job, setJob] = useState(null);
  const [query, setQuery] = useState(null); // submitted {skills, job}

  const result = useApi(
    () => api.careerBuilder(query.skills, query.job),
    [query],
    { enabled: Boolean(query) },
  );

  const addSkill = (entity) => {
    if (entity && !skills.some((s) => s.name === entity.name)) setSkills([...skills, entity]);
  };
  const removeSkill = (name) => setSkills(skills.filter((s) => s.name !== name));

  const plan = result.data;
  const core = plan?.requirements.core;
  const nice = plan?.requirements.niceToHave;
  const covered = [...(core?.covered ?? []), ...(nice?.covered ?? [])];
  const routesBySkill = new Map((plan?.routes ?? []).map((r) => [r.skill, r.route]));
  const coursesFor = (skill) => plan.gapCourses.find((g) => g.skill === skill)?.courses ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Path Builder</h1>
        <p className="mt-1 text-slate-400">
          Tell the graph what you know and where you want to go — it answers with your gaps, a
          learning route, the job's stack, and courses that actually teach the missing pieces.
        </p>
      </header>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <EntityPicker
              id="builder-skills"
              title="Skills I have"
              fixedLabel="Skill"
              value={null}
              onChange={addSkill}
              clearOnSelect
            />
            {skills.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Selected skills">
                {skills.map((s) => (
                  <li key={s.name}>
                    <SkillChip name={s.name} tone="plain" onRemove={() => removeSkill(s.name)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <EntityPicker id="builder-job" title="Target job" fixedLabel="Job" value={job} onChange={setJob} />
            {job && <p className="mt-3 text-sm text-slate-400">Target: <span className="text-slate-200">{job.name}</span></p>}
          </div>
        </div>
        <button
          type="button"
          disabled={skills.length === 0 || !job}
          onClick={() => setQuery({ skills: skills.map((s) => s.name), job: job.name })}
          className="rounded-lg bg-indigo-500 px-5 py-2.5 font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300"
        >
          Build My Path
        </button>
      </section>

      {!query && (
        <EmptyState
          title="Pick your skills and a target job"
          hint='Try skills "Python" and "SQL" with the target job "ML Engineer".'
        />
      )}
      {query && result.loading && <Loading label="Asking the graph…" />}
      {query && result.error && <ErrorState error={result.error} onRetry={result.retry} />}

      {plan && (
        <div className="space-y-4">
          {/* Target + explainable coverage counts */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-bold">{plan.job.name}</h2>
              <Badge label="Job" />
              <span className="text-sm text-slate-500">
                {plan.job.level} · ${Number(plan.job.avgSalaryUSD).toLocaleString('en-US')} avg
              </span>
            </div>
            <p className="mt-1.5 text-slate-400">{plan.job.description}</p>
            <p className="mt-3 text-sm font-medium text-slate-200">
              {core.covered.length} of {core.covered.length + core.missing.length} core skills covered
              <span className="mx-2 text-slate-600">·</span>
              {nice.covered.length} of {nice.covered.length + nice.missing.length} nice-to-have covered
            </p>
          </section>

          <FlowArrow />

          {/* What you already have */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-label="What you already have">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">What you already have</h3>
            {covered.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {covered.map((s) => <li key={s.skill}><SkillChip name={`✓ ${s.skill}`} tone="have" /></li>)}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-slate-500">
                None of your selected skills are on this job's requirement list — the sections below
                are your full starting map.
              </p>
            )}
          </section>

          <FlowArrow />

          {/* Gaps */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-label="Skill gaps">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Skill gaps</h3>
            {core.missing.length === 0 && nice.missing.length === 0 && (
              <p className="mt-3 text-sm text-emerald-300">
                No gaps — you cover every skill this job requires.
              </p>
            )}
            {core.missing.length > 0 && (
              <div className="mt-3">
                <p className="text-sm text-slate-300">Core — required for the role:</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {core.missing.map((s) => (
                    <li key={s.skill} title={s.description}><SkillChip name={s.skill} tone="core" /></li>
                  ))}
                </ul>
              </div>
            )}
            {nice.missing.length > 0 && (
              <div className="mt-3">
                <p className="text-sm text-slate-300">
                  Nice-to-have — strengthens your profile
                  <span className="text-slate-500"> (no learning route is drawn for these; their courses appear in the last section)</span>:
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {nice.missing.map((s) => (
                    <li key={s.skill} title={s.description}><SkillChip name={s.skill} tone="nice" /></li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <FlowArrow />

          {/* Learning route */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-label="Learning route">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Learning route</h3>
            <p className="mt-1 text-xs text-slate-500">
              Routes are computed for <span className="text-rose-300">core</span> skill gaps — the
              skills the role requires. Nice-to-have gaps are listed above and get course
              suggestions below instead of a route.
            </p>
            {core.missing.length === 0 ? (
              <p className="mt-3 text-sm text-emerald-300">
                You already cover every core skill — no learning route needed. Consider the
                nice-to-haves and the stack below to strengthen your profile.
              </p>
            ) : (
              <div className="mt-3 space-y-5">
                {core.missing.map((gap) => {
                  const route = routesBySkill.get(gap.skill);
                  return (
                    <div key={gap.skill}>
                      {route ? (
                        <>
                          <PathDiagram
                            nodes={[
                              ...route.map((name) => ({ label: 'Skill', name })),
                              { label: 'Job', name: plan.job.name },
                            ]}
                            edges={[
                              ...route.slice(1).map(() => ({ label: 'LEADS_TO', direction: 'forward' })),
                              { label: 'REQUIRES', direction: 'backward' },
                            ]}
                          />
                          <p className="mt-1 text-center text-xs text-slate-500">
                            Read left to right as your learning journey. The last arrowhead points
                            backwards on purpose: the graph stores{' '}
                            <span className="text-slate-400">{plan.job.name} —REQUIRES→ {gap.skill}</span>,
                            while your journey travels that edge the other way.
                          </p>
                        </>
                      ) : (
                        <p className="rounded-lg border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400">
                          <span className="text-slate-200">{gap.skill}</span> — no route from your current
                          skills in the graph. Start learning it directly
                          {coursesFor(gap.skill).length > 0 ? ' (see courses below).' : '.'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <FlowArrow />

          {/* Relevant technologies */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-label="Relevant technologies">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              The {plan.job.name} stack
            </h3>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {plan.technologies.map((tech) => (
                <div key={tech.technology} className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/explorer/Technology/${encodeURIComponent(tech.technology)}`}
                      className="font-semibold text-slate-100 hover:text-indigo-300"
                    >
                      {tech.technology}
                    </Link>
                    <span className="text-xs text-slate-500">{tech.type}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{tech.description}</p>
                  <p className="mt-2 text-xs">
                    {tech.prerequisitesMissing.length === 0 ? (
                      <span className="text-emerald-300">✓ Ready to learn with your current skills</span>
                    ) : (
                      <span className="text-amber-300">Needs first: {tech.prerequisitesMissing.join(', ')}</span>
                    )}
                  </p>
                  {tech.courses.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {tech.courses.map((course) => (
                        <li key={course.name}>
                          <a href={course.url} target="_blank" rel="noreferrer" className="text-sm text-violet-300 hover:text-violet-200">
                            {course.name} ↗ <span className="text-xs text-slate-500">({course.provider})</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>

          <FlowArrow />

          {/* Courses for missing skills */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-label="Courses for missing skills">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              Courses for your missing skills
            </h3>
            {plan.gapCourses.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No missing skills — nothing to study here.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {plan.gapCourses.map((gap) => (
                  <div key={gap.skill} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="w-40 shrink-0 text-sm font-medium text-slate-200">{gap.skill}</span>
                    {gap.courses.length > 0 ? (
                      <ul className="flex flex-wrap gap-x-4 gap-y-1">
                        {gap.courses.map((course) => (
                          <li key={course.name}>
                            <a href={course.url} target="_blank" rel="noreferrer" className="text-sm text-violet-300 hover:text-violet-200">
                              {course.name} ↗ <span className="text-xs text-slate-500">({course.provider} · {course.level})</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="rounded border border-dashed border-slate-700 px-2 py-0.5 text-sm text-slate-500">
                        No course in the graph teaches this yet.
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
