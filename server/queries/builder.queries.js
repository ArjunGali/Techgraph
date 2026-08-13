// Queries behind the Career/Learning Path Builder.
//
// The builder is deliberately four small composable queries instead of one
// giant Cypher statement: each answers one question a human can state in a
// sentence, and the service layer stitches the answers together. Nothing is
// written back to the database — the graph stays the source of truth.

// Which of the user's claimed skills actually exist? (Input hygiene: the
// service turns any difference into a clear NotFound error.)
export const VALIDATE_SKILLS = `
MATCH (s:Skill)
WHERE s.name IN $skills
RETURN s.name AS name`;

// Q1 — requirements + coverage in one pass: every skill the target job
// requires, its level on the REQUIRES edge, and whether it is already in
// the user's selected skills. The gap analysis is this query's output
// partitioned by (level, covered) — explainable counts, no scores.
export const JOB_REQUIREMENTS_COVERAGE = `
MATCH (j:Job {name: $job})-[r:REQUIRES]->(s:Skill)
RETURN s.name AS skill,
       s.description AS description,
       r.level AS level,
       s.name IN $skills AS covered
ORDER BY r.level, s.name`;

// Q2 — learning routes: for each missing core skill, the shortest LEADS_TO
// chain from ANY skill the user already has. Both endpoints are bound before
// shortestPath runs; ORDER BY + collect(p)[0] keeps only the best route per
// gap. A gap with no row simply has no route from the user's current skills
// (the UI says "start here directly") — that is an honest answer, not an
// error.
export const LEARNING_ROUTES = `
MATCH (have:Skill) WHERE have.name IN $skills
MATCH (gap:Skill) WHERE gap.name IN $gapSkills
MATCH p = shortestPath((have)-[:LEADS_TO*1..4]->(gap))
WITH gap, p
ORDER BY length(p) ASC
WITH gap, collect(p)[0] AS best
RETURN gap.name AS skill,
       [n IN nodes(best) | n.name] AS route`;

// Q3 — the target job's technology stack, with each technology's skill
// prerequisites (so the UI can say "ready now" vs "needs X first") and any
// courses that teach it. OPTIONAL MATCH keeps course-less technologies.
export const JOB_TECHNOLOGIES = `
MATCH (j:Job {name: $job})-[:USES]->(t:Technology)
OPTIONAL MATCH (t)-[:REQUIRES]->(prereq:Skill)
OPTIONAL MATCH (t)<-[:TEACHES]-(c:Course)
RETURN t.name AS technology,
       t.type AS type,
       t.description AS description,
       collect(DISTINCT prereq.name) AS prerequisites,
       collect(DISTINCT c { .name, .provider, .url, .level }) AS courses
ORDER BY technology`;

// Q4 — courses that directly teach the missing skills. Gaps with an empty
// course list surface the standard empty state — never an invented
// recommendation.
export const GAP_SKILL_COURSES = `
MATCH (s:Skill)
WHERE s.name IN $gapSkills
OPTIONAL MATCH (s)<-[:TEACHES]-(c:Course)
RETURN s.name AS skill,
       collect(c { .name, .provider, .url, .level }) AS courses
ORDER BY skill`;
