// TechGraph seed script.
//
//   npm run seed                         — validate, then reset & load CognoDB
//   node seed/seed.js --validate-only    — check the dataset without a database
//
// WARNING: seeding DELETES ALL DATA in the target database first, so the
// script is idempotent — running it twice yields the same graph.
import 'dotenv/config';
import { getDriver, checkConnectivity, closeDriver } from '../config/db.js';
import {
  skills, technologies, concepts, jobs, companies, courses,
  leadsTo, techRequires, worksWith, usedFor, jobRequires, jobUses,
  hiresFor, teachesSkill, teachesTechnology,
} from './data.js';

const NODES = [
  { label: 'Skill', rows: skills, cypher: 'UNWIND $rows AS row CREATE (n:Skill) SET n = row' },
  { label: 'Technology', rows: technologies, cypher: 'UNWIND $rows AS row CREATE (n:Technology) SET n = row' },
  { label: 'Concept', rows: concepts, cypher: 'UNWIND $rows AS row CREATE (n:Concept) SET n = row' },
  { label: 'Job', rows: jobs, cypher: 'UNWIND $rows AS row CREATE (n:Job) SET n = row' },
  { label: 'Company', rows: companies, cypher: 'UNWIND $rows AS row CREATE (n:Company) SET n = row' },
  { label: 'Course', rows: courses, cypher: 'UNWIND $rows AS row CREATE (n:Course) SET n = row' },
];

// Node names travel as parameters; labels and relationship types are written
// literally — Cypher is never assembled from data.
const RELATIONSHIPS = [
  {
    name: 'LEADS_TO (Skill→Skill)', rows: leadsTo, fromLabel: 'Skill', toLabel: 'Skill',
    cypher: `UNWIND $rows AS row
             MATCH (a:Skill {name: row.from}) MATCH (b:Skill {name: row.to})
             CREATE (a)-[:LEADS_TO]->(b)`,
  },
  {
    name: 'REQUIRES (Technology→Skill)', rows: techRequires, fromLabel: 'Technology', toLabel: 'Skill',
    cypher: `UNWIND $rows AS row
             MATCH (a:Technology {name: row.from}) MATCH (b:Skill {name: row.to})
             CREATE (a)-[:REQUIRES]->(b)`,
  },
  {
    name: 'WORKS_WITH (Technology↔Technology)', rows: worksWith, fromLabel: 'Technology', toLabel: 'Technology',
    cypher: `UNWIND $rows AS row
             MATCH (a:Technology {name: row.from}) MATCH (b:Technology {name: row.to})
             CREATE (a)-[:WORKS_WITH]->(b)`,
  },
  {
    name: 'USED_FOR (Technology→Concept)', rows: usedFor, fromLabel: 'Technology', toLabel: 'Concept',
    cypher: `UNWIND $rows AS row
             MATCH (a:Technology {name: row.from}) MATCH (b:Concept {name: row.to})
             CREATE (a)-[:USED_FOR]->(b)`,
  },
  {
    name: 'REQUIRES (Job→Skill, with level)', rows: jobRequires, fromLabel: 'Job', toLabel: 'Skill',
    cypher: `UNWIND $rows AS row
             MATCH (a:Job {name: row.from}) MATCH (b:Skill {name: row.to})
             CREATE (a)-[:REQUIRES {level: row.level}]->(b)`,
  },
  {
    name: 'USES (Job→Technology)', rows: jobUses, fromLabel: 'Job', toLabel: 'Technology',
    cypher: `UNWIND $rows AS row
             MATCH (a:Job {name: row.from}) MATCH (b:Technology {name: row.to})
             CREATE (a)-[:USES]->(b)`,
  },
  {
    name: 'HIRES_FOR (Company→Job)', rows: hiresFor, fromLabel: 'Company', toLabel: 'Job',
    cypher: `UNWIND $rows AS row
             MATCH (a:Company {name: row.from}) MATCH (b:Job {name: row.to})
             CREATE (a)-[:HIRES_FOR]->(b)`,
  },
  {
    name: 'TEACHES (Course→Skill)', rows: teachesSkill, fromLabel: 'Course', toLabel: 'Skill',
    cypher: `UNWIND $rows AS row
             MATCH (a:Course {name: row.from}) MATCH (b:Skill {name: row.to})
             CREATE (a)-[:TEACHES]->(b)`,
  },
  {
    name: 'TEACHES (Course→Technology)', rows: teachesTechnology, fromLabel: 'Course', toLabel: 'Technology',
    cypher: `UNWIND $rows AS row
             MATCH (a:Course {name: row.from}) MATCH (b:Technology {name: row.to})
             CREATE (a)-[:TEACHES]->(b)`,
  },
];

const CONSTRAINTS = [
  'CREATE CONSTRAINT skill_name_unique IF NOT EXISTS FOR (n:Skill) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT technology_name_unique IF NOT EXISTS FOR (n:Technology) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT concept_name_unique IF NOT EXISTS FOR (n:Concept) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT job_name_unique IF NOT EXISTS FOR (n:Job) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT company_name_unique IF NOT EXISTS FOR (n:Company) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT course_name_unique IF NOT EXISTS FOR (n:Course) REQUIRE n.name IS UNIQUE',
];

// Referential check of the dataset itself, before touching the database:
// duplicate names, dangling relationship endpoints, invalid level values.
function validateData() {
  const problems = [];
  const namesByLabel = {};

  for (const { label, rows } of NODES) {
    namesByLabel[label] = new Set();
    for (const row of rows) {
      if (namesByLabel[label].has(row.name)) {
        problems.push(`Duplicate ${label} name: "${row.name}"`);
      }
      namesByLabel[label].add(row.name);
    }
  }

  for (const { name, rows, fromLabel, toLabel } of RELATIONSHIPS) {
    for (const row of rows) {
      if (!namesByLabel[fromLabel].has(row.from)) {
        problems.push(`${name}: unknown ${fromLabel} "${row.from}"`);
      }
      if (!namesByLabel[toLabel].has(row.to)) {
        problems.push(`${name}: unknown ${toLabel} "${row.to}"`);
      }
    }
  }

  for (const row of jobRequires) {
    if (row.level !== 'core' && row.level !== 'nice-to-have') {
      problems.push(`REQUIRES (Job→Skill) ${row.from}→${row.to}: invalid level "${row.level}"`);
    }
  }

  return problems;
}

async function main() {
  const problems = validateData();
  const nodeTotal = NODES.reduce((sum, n) => sum + n.rows.length, 0);
  const relTotal = RELATIONSHIPS.reduce((sum, r) => sum + r.rows.length, 0);

  if (problems.length > 0) {
    console.error(`Dataset INVALID — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Dataset valid: ${nodeTotal} nodes, ${relTotal} relationships.`);
  for (const { label, rows } of NODES) console.log(`  ${label.padEnd(12)} ${rows.length}`);
  for (const { name, rows } of RELATIONSHIPS) console.log(`  ${name.padEnd(36)} ${rows.length}`);

  if (process.argv.includes('--validate-only')) return;

  const db = await checkConnectivity();
  if (!db.connected) {
    console.error(
      db.reason === 'not_configured'
        ? '\nCannot seed: CognoDB is not configured. Copy server/.env.example to server/.env and fill in your credentials.'
        : '\nCannot seed: CognoDB is unreachable. Check COGNODB_URI and that the instance is running.',
    );
    process.exitCode = 1;
    return;
  }

  const session = getDriver().session();
  try {
    console.log('\nCreating uniqueness constraints...');
    for (const statement of CONSTRAINTS) {
      await session.run(statement);
    }

    console.log('Deleting existing data...');
    await session.run('MATCH (n) DETACH DELETE n');

    console.log('Creating nodes...');
    for (const { label, rows, cypher } of NODES) {
      const result = await session.run(cypher, { rows });
      const { nodesCreated } = result.summary.counters.updates();
      if (nodesCreated !== rows.length) {
        throw new Error(`${label}: expected ${rows.length} nodes, created ${nodesCreated}`);
      }
    }

    console.log('Creating relationships...');
    for (const { name, rows, cypher } of RELATIONSHIPS) {
      const result = await session.run(cypher, { rows });
      const { relationshipsCreated } = result.summary.counters.updates();
      if (relationshipsCreated !== rows.length) {
        throw new Error(`${name}: expected ${rows.length} relationships, created ${relationshipsCreated}`);
      }
    }

    // Report what is actually in the database, not what we intended to load.
    const nodeCounts = await session.run(
      'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label',
    );
    const relCounts = await session.run(
      'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type',
    );

    console.log('\nSeed complete. Database now contains:');
    for (const record of nodeCounts.records) {
      console.log(`  (:${record.get('label')})`.padEnd(16) + record.get('count'));
    }
    for (const record of relCounts.records) {
      console.log(`  [:${record.get('type')}]`.padEnd(16) + record.get('count'));
    }
  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch(async (err) => {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
  await closeDriver();
});
