// Service layer: validates input, runs queries through the shared session
// helpers, and turns driver records into plain JSON. Sessions themselves are
// opened and closed (in a finally block) inside config/db.js — no code here
// ever holds a session.
import { run } from './run.js';
import * as q from '../queries/index.js';
import { ValidationError, NotFoundError } from './errors.js';

// --- input validation ------------------------------------------------------

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  return value.trim();
}

function requireLabel(value, field) {
  const label = requireText(value, field);
  if (!q.ENTITY_LABELS.includes(label)) {
    throw new ValidationError(`${field} must be one of: ${q.ENTITY_LABELS.join(', ')}`);
  }
  return label;
}

// --- Explorer / Dashboard --------------------------------------------------

export async function searchEntities(term) {
  return run(q.SEARCH_ENTITIES, { term: requireText(term, 'search term') });
}

export async function getEntity(label, name) {
  const params = { label: requireLabel(label, 'type'), name: requireText(name, 'name') };
  const rows = await run(q.GET_ENTITY, params);
  if (rows.length === 0) {
    throw new NotFoundError(`No ${params.label} named "${params.name}" exists.`);
  }
  return rows[0];
}

export async function getEntityRelationships(label, name) {
  await getEntity(label, name); // 404 for unknown entities, not an empty list
  const rows = await run(q.GET_ENTITY_RELATIONSHIPS, {
    label: requireLabel(label, 'type'),
    name: requireText(name, 'name'),
  });

  // Group flat rows into one entry per (relationship type, direction), e.g.
  // { type: "REQUIRES", direction: "outgoing", entities: [...] }.
  const groups = new Map();
  for (const row of rows) {
    const direction = row.outgoing ? 'outgoing' : 'incoming';
    const key = `${row.type}|${direction}`;
    if (!groups.has(key)) {
      groups.set(key, { type: row.type, direction, entities: [] });
    }
    groups.get(key).entities.push({
      label: row.label,
      name: row.name,
      description: row.description,
      relationship: row.relProperties, // e.g. { level: "core" } on REQUIRES
    });
  }
  return [...groups.values()];
}

export async function getGraphStats() {
  const [nodeCounts, relCount, topSkills] = await Promise.all([
    run(q.COUNT_NODES_BY_LABEL, {}),
    run(q.COUNT_RELATIONSHIPS, {}),
    run(q.TOP_REQUIRED_SKILLS, {}),
  ]);
  return {
    nodesByLabel: Object.fromEntries(nodeCounts.map((r) => [r.label, r.count])),
    totalNodes: nodeCounts.reduce((sum, r) => sum + r.count, 0),
    totalRelationships: relCount[0].count,
    topRequiredSkills: topSkills,
  };
}

// --- Career queries --------------------------------------------------------

export async function jobsRequiringSkill(skill) {
  return run(q.JOBS_REQUIRING_SKILL, { skill: requireText(skill, 'skill') });
}

// Both notions of "related": commonly-used-together (WORKS_WITH) and
// shared purpose (T3 — related, not interchangeable).
export async function relatedTechnologies(technology) {
  const params = { technology: requireText(technology, 'technology') };
  const [worksWith, sharedPurpose] = await Promise.all([
    run(q.WORKS_WITH_TECHNOLOGIES, params),
    run(q.SHARED_PURPOSE_TECHNOLOGIES, params),
  ]);
  return { worksWith, sharedPurpose };
}

export async function careerDiscovery(skill) {
  return run(q.CAREER_DISCOVERY, { skill: requireText(skill, 'skill') });
}

export async function studyPath(skill) {
  return run(q.STUDY_PATH, { skill: requireText(skill, 'skill') });
}

export async function employersForSkill(skill, level) {
  const requirement = requireText(level, 'level');
  if (!q.REQUIREMENT_LEVELS.includes(requirement)) {
    throw new ValidationError(`level must be one of: ${q.REQUIREMENT_LEVELS.join(', ')}`);
  }
  return run(q.EMPLOYERS_FOR_SKILL, { skill: requireText(skill, 'skill'), level: requirement });
}

// --- Connection Explorer ---------------------------------------------------

// Returns { nodes, relationships } for the shortest path, or null when the
// entities exist but no path connects them within the hop cap.
export async function shortestPath(fromLabel, fromName, toLabel, toName) {
  const params = {
    fromLabel: requireLabel(fromLabel, 'from type'),
    fromName: requireText(fromName, 'from name'),
    toLabel: requireLabel(toLabel, 'to type'),
    toName: requireText(toName, 'to name'),
  };
  if (params.fromLabel === params.toLabel && params.fromName === params.toName) {
    throw new ValidationError('Choose two different entities to connect.');
  }
  // Check both endpoints first so "unknown entity" is a 404, not "no path".
  await getEntity(params.fromLabel, params.fromName);
  await getEntity(params.toLabel, params.toName);

  const rows = await run(q.SHORTEST_PATH, params);
  return rows.length === 0 ? null : rows[0];
}
