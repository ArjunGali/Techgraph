// The Career/Learning Path Builder: composes four focused queries into one
// answer to "I know these skills and want this job — what am I missing,
// how do I get there, and what can I study?". Read-only: nothing is ever
// written back to the graph.
import { run } from './run.js';
import { getEntity } from './graph.service.js';
import * as q from '../queries/index.js';
import { ValidationError, NotFoundError } from './errors.js';

export async function buildCareerPath(skills, job) {
  // -- input validation -----------------------------------------------------
  if (!Array.isArray(skills) || skills.length === 0) {
    throw new ValidationError('Select at least one skill you already have.');
  }
  const cleaned = [...new Set(skills.map((s) => String(s).trim()).filter((s) => s !== ''))];
  if (cleaned.length === 0) {
    throw new ValidationError('Select at least one skill you already have.');
  }
  if (typeof job !== 'string' || job.trim() === '') {
    throw new ValidationError('Choose a target job.');
  }

  // -- entity existence (clean 404s, not silent empty results) --------------
  const jobEntity = await getEntity('Job', job.trim());
  const known = await run(q.VALIDATE_SKILLS, { skills: cleaned });
  const knownNames = new Set(known.map((row) => row.name));
  const unknown = cleaned.filter((name) => !knownNames.has(name));
  if (unknown.length > 0) {
    throw new NotFoundError(`No Skill named ${unknown.map((n) => `"${n}"`).join(', ')} exists.`);
  }

  // -- Q1: requirements + coverage, partitioned by (level, covered) ---------
  const requirements = await run(q.JOB_REQUIREMENTS_COVERAGE, {
    job: jobEntity.properties.name,
    skills: cleaned,
  });
  const partition = (level) => ({
    covered: requirements.filter((r) => r.level === level && r.covered)
      .map(({ skill, description }) => ({ skill, description })),
    missing: requirements.filter((r) => r.level === level && !r.covered)
      .map(({ skill, description }) => ({ skill, description })),
  });
  const core = partition('core');
  const niceToHave = partition('nice-to-have');
  const allGaps = [...core.missing, ...niceToHave.missing].map((g) => g.skill);

  // -- Q2/Q3/Q4 in parallel: routes to core gaps, the job's stack, courses --
  const [routes, technologies, gapCourses] = await Promise.all([
    core.missing.length > 0
      ? run(q.LEARNING_ROUTES, { skills: cleaned, gapSkills: core.missing.map((g) => g.skill) })
      : Promise.resolve([]),
    run(q.JOB_TECHNOLOGIES, { job: jobEntity.properties.name }),
    allGaps.length > 0
      ? run(q.GAP_SKILL_COURSES, { gapSkills: allGaps })
      : Promise.resolve([]),
  ]);

  // Annotate each stack technology with which prerequisites the user lacks,
  // so the UI can say "ready to learn now" vs "needs Machine Learning first".
  const have = new Set(cleaned);
  const stack = technologies.map((tech) => ({
    ...tech,
    prerequisitesMissing: tech.prerequisites.filter((p) => !have.has(p)),
  }));

  return {
    job: { label: 'Job', ...jobEntity.properties },
    skillsSelected: cleaned,
    requirements: { core, niceToHave },
    // Learning routes exist only where a LEADS_TO chain connects the user's
    // skills to a missing core skill; gaps without a route are honest "start
    // here directly" cases the UI renders explicitly.
    routes,
    technologies: stack,
    gapCourses,
  };
}
