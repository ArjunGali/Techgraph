import { buildCareerPath } from '../services/builder.service.js';
import { requireQuery } from './validate.js';

// GET /api/career-builder?skills=Python&skills=SQL&job=ML%20Engineer
// `skills` repeats once per selected skill; Express parses repeats into an
// array (a single value arrives as a string, hence the concat).
export async function careerBuilder(req, res) {
  const skills = [].concat(req.query.skills ?? []);
  const job = requireQuery(req, 'job');
  res.json(await buildCareerPath(skills, job));
}
