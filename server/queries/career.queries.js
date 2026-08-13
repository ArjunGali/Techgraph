// Queries behind career exploration: jobs for a skill, related technologies,
// and the T1/T2/T4 traversals from docs/DATA_MODEL.md.

// Which jobs require a skill, and how hard the requirement is.
// ORDER BY requirement puts 'core' before 'nice-to-have' (alphabetical, on
// purpose).
export const JOBS_REQUIRING_SKILL = `
MATCH (j:Job)-[r:REQUIRES]->(s:Skill {name: $skill})
RETURN j.name AS job,
       j.level AS seniority,
       j.avgSalaryUSD AS avgSalaryUSD,
       j.description AS description,
       r.level AS requirement
ORDER BY requirement, job`;

// Technologies commonly used together. WORKS_WITH is semantically symmetric
// and stored once per pair, so the pattern is matched without direction.
export const WORKS_WITH_TECHNOLOGIES = `
MATCH (t:Technology {name: $technology})-[:WORKS_WITH]-(other:Technology)
RETURN other.name AS technology, other.type AS type, other.description AS description
ORDER BY technology`;

// T3 — related technologies via shared purpose (common-neighbor pattern).
// Sharing a USED_FOR concept is evidence of relatedness, NOT proof one
// technology can substitute for another; the UI wording is "related
// technologies".
export const SHARED_PURPOSE_TECHNOLOGIES = `
MATCH (t:Technology {name: $technology})-[:USED_FOR]->(c:Concept)<-[:USED_FOR]-(other:Technology)
RETURN other.name AS technology, collect(c.name) AS sharedPurposes
ORDER BY size(sharedPurposes) DESC, technology ASC`;

// T1 — the multi-hop showcase: from a skill, through the skills it leads to,
// into the technologies that build on those skills, and out to the jobs that
// use those technologies. 3 hops across 3 node types. With $skill = "Python"
// the seeded graph yields Python → Machine Learning → PyTorch → ML Engineer
// among others — discovered, never hard-coded.
export const CAREER_DISCOVERY = `
MATCH path = (s:Skill {name: $skill})-[:LEADS_TO*1..2]->(:Skill)
             <-[:REQUIRES]-(:Technology)<-[:USES]-(j:Job)
RETURN [n IN nodes(path) | {label: labels(n)[0], name: n.name}] AS steps,
       [r IN relationships(path) | type(r)] AS relationshipTypes,
       j.name AS job
ORDER BY length(path), job
LIMIT 10`;

// T2 — study path: technologies within reach from a skill you already have,
// with the courses that teach them. OPTIONAL MATCH keeps technologies that
// have no course in the results ("related courses where available").
export const STUDY_PATH = `
MATCH (s:Skill {name: $skill})<-[:REQUIRES]-(t:Technology)
OPTIONAL MATCH (t)<-[:TEACHES]-(c:Course)
RETURN t.name AS technology,
       t.type AS type,
       t.description AS description,
       collect(c { .name, .provider, .url, .level }) AS courses
ORDER BY technology`;

// T4 — employers reachable from a skill, filtering on the REQUIRES edge
// property mid-traversal ($level is 'core' or 'nice-to-have').
export const EMPLOYERS_FOR_SKILL = `
MATCH (s:Skill {name: $skill})<-[r:REQUIRES]-(j:Job)<-[:HIRES_FOR]-(co:Company)
WHERE r.level = $level
RETURN co.name AS company, co.industry AS industry, collect(DISTINCT j.name) AS jobs
ORDER BY company`;
