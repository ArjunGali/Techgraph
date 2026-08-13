import * as graph from '../services/graph.service.js';
import { requireQuery } from './validate.js';

// Each handler first resolves the referenced entity so an unknown skill or
// technology is a clean 404, distinguishable from "exists but no results"
// (200 with an empty list).

// GET /api/jobs/requiring/:skill
export async function jobsRequiringSkill(req, res) {
  await graph.getEntity('Skill', req.params.skill);
  const jobs = await graph.jobsRequiringSkill(req.params.skill);
  res.json({ jobs });
}

// GET /api/technologies/:name/related
export async function relatedTechnologies(req, res) {
  await graph.getEntity('Technology', req.params.name);
  res.json(await graph.relatedTechnologies(req.params.name));
}

// GET /api/career-path?skill=Python  (T1)
export async function careerPath(req, res) {
  const skill = requireQuery(req, 'skill');
  await graph.getEntity('Skill', skill);
  const paths = await graph.careerDiscovery(skill);
  res.json({ paths });
}

// GET /api/study-path?skill=Python  (T2)
export async function studyPath(req, res) {
  const skill = requireQuery(req, 'skill');
  await graph.getEntity('Skill', skill);
  const technologies = await graph.studyPath(skill);
  res.json({ technologies });
}

// GET /api/employers-for-skill?skill=Python&level=core  (T4)
export async function employersForSkill(req, res) {
  const skill = requireQuery(req, 'skill');
  const level = requireQuery(req, 'level');
  await graph.getEntity('Skill', skill);
  const employers = await graph.employersForSkill(skill, level);
  res.json({ employers });
}
