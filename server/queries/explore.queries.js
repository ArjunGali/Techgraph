// Queries behind the Dashboard and Explorer.
// Every value that varies travels as a $parameter; labels and relationship
// types are literal. LIMITs are literal because they are application
// constants, not user input (and the JS driver sends plain numbers as
// floats, which LIMIT rejects).

// Case-insensitive substring search across all entities. Shorter names sort
// first so exact-ish matches ("Python") beat longer ones ("Python for
// Everybody").
export const SEARCH_ENTITIES = `
MATCH (n)
WHERE toLower(n.name) CONTAINS toLower($term)
RETURN labels(n)[0] AS label, n.name AS name, n.description AS description
ORDER BY size(n.name) ASC, n.name ASC
LIMIT 20`;

// Entity lookup by unambiguous (label, name) pair. Cypher cannot put a
// parameter in the label position of a pattern, so `$label IN labels(n)` is
// the standard fully-parameterized equivalent.
export const GET_ENTITY = `
MATCH (n)
WHERE $label IN labels(n) AND n.name = $name
RETURN labels(n)[0] AS label, properties(n) AS properties
LIMIT 1`;

// One-hop neighborhood of an entity, with enough metadata to group results
// by relationship type and direction ("REQUIRES →" vs "← REQUIRES").
export const GET_ENTITY_RELATIONSHIPS = `
MATCH (n)-[r]-(m)
WHERE $label IN labels(n) AND n.name = $name
RETURN type(r) AS type,
       startNode(r) = n AS outgoing,
       properties(r) AS relProperties,
       labels(m)[0] AS label,
       m.name AS name,
       m.description AS description
ORDER BY type, name`;

// Dashboard statistics — three small aggregations.
export const COUNT_NODES_BY_LABEL = `
MATCH (n)
UNWIND labels(n) AS label
RETURN label, count(*) AS count
ORDER BY label`;

export const COUNT_RELATIONSHIPS = `
MATCH ()-[r]->()
RETURN count(r) AS count`;

export const TOP_REQUIRED_SKILLS = `
MATCH (j:Job)-[:REQUIRES]->(s:Skill)
RETURN s.name AS skill, count(j) AS jobs
ORDER BY jobs DESC, skill ASC
LIMIT 5`;
