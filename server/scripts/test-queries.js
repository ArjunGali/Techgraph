// Repeatable query-layer test: runs every service function against the live
// CognoDB database, prints concise human-readable results, and asserts key
// expectations. Exit code 0 = all checks passed.
//
//   npm run test:queries
import 'dotenv/config';
import { closeDriver } from '../config/db.js';
import * as graph from '../services/graph.service.js';
import { ValidationError, NotFoundError } from '../services/errors.js';

let passed = 0;
let failed = 0;

async function check(title, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`\nPASS  ${title}`);
    if (detail) console.log(detail.replace(/^/gm, '      '));
  } catch (err) {
    failed += 1;
    console.log(`\nFAIL  ${title}`);
    console.log(`      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const arrow = (steps) => steps.map((s) => s.name).join(' → ');

// --- Explorer / Dashboard --------------------------------------------------

await check('searchEntities("py") finds Python and PyTorch', async () => {
  const results = await graph.searchEntities('py');
  const names = results.map((r) => r.name);
  assert(names.includes('Python'), `expected Python in [${names}]`);
  assert(names.includes('PyTorch'), `expected PyTorch in [${names}]`);
  return results.slice(0, 4).map((r) => `${r.label}: ${r.name}`).join('\n');
});

await check('getEntity(Skill, Python) returns the node', async () => {
  const entity = await graph.getEntity('Skill', 'Python');
  assert(entity.label === 'Skill', 'label should be Skill');
  assert(entity.properties.difficulty === 'beginner', 'difficulty should be beginner');
  return `${entity.label} "${entity.properties.name}" (${entity.properties.category}, ${entity.properties.difficulty})`;
});

await check('getEntity(Skill, "Quantum Basket Weaving") throws NotFoundError', async () => {
  try {
    await graph.getEntity('Skill', 'Quantum Basket Weaving');
  } catch (err) {
    assert(err instanceof NotFoundError, `expected NotFoundError, got ${err.name}`);
    return err.message;
  }
  assert(false, 'no error was thrown');
});

await check('getEntity with invalid label throws ValidationError', async () => {
  try {
    await graph.getEntity('Wizard', 'Python');
  } catch (err) {
    assert(err instanceof ValidationError, `expected ValidationError, got ${err.name}`);
    return err.message;
  }
  assert(false, 'no error was thrown');
});

await check('getEntityRelationships(Technology, PyTorch) groups by type+direction', async () => {
  const groups = await graph.getEntityRelationships('Technology', 'PyTorch');
  const requires = groups.find((g) => g.type === 'REQUIRES' && g.direction === 'outgoing');
  assert(requires, 'expected an outgoing REQUIRES group');
  const names = requires.entities.map((e) => e.name);
  assert(names.includes('Python'), `PyTorch should require Python, got [${names}]`);
  return groups.map((g) => `${g.type} (${g.direction}): ${g.entities.map((e) => e.name).join(', ')}`).join('\n');
});

await check('getGraphStats() matches the seeded graph exactly', async () => {
  const stats = await graph.getGraphStats();
  assert(stats.totalNodes === 76, `expected 76 nodes, got ${stats.totalNodes}`);
  assert(stats.totalRelationships === 185, `expected 185 relationships, got ${stats.totalRelationships}`);
  return `76 nodes, 185 relationships; most-required skill: ${stats.topRequiredSkills[0].skill} (${stats.topRequiredSkills[0].jobs} jobs)`;
});

// --- Career queries --------------------------------------------------------

await check('jobsRequiringSkill(Python) lists core requirements first', async () => {
  const jobsList = await graph.jobsRequiringSkill('Python');
  assert(jobsList.length > 0, 'expected at least one job');
  assert(jobsList[0].requirement === 'core', 'core requirements should sort first');
  const mle = jobsList.find((j) => j.job === 'ML Engineer');
  assert(mle && mle.requirement === 'core', 'ML Engineer should require Python as core');
  return jobsList.map((j) => `${j.job} (${j.requirement}, $${j.avgSalaryUSD.toLocaleString('en-US')})`).join('\n');
});

await check('relatedTechnologies(PyTorch): works-with + shared purpose (T3)', async () => {
  const { worksWith, sharedPurpose } = await graph.relatedTechnologies('PyTorch');
  assert(worksWith.some((t) => t.technology === 'NumPy'), 'PyTorch should work with NumPy');
  const tf = sharedPurpose.find((t) => t.technology === 'TensorFlow');
  assert(tf, 'TensorFlow should share a purpose with PyTorch');
  assert(tf.sharedPurposes.length === 2, 'PyTorch and TensorFlow share two purposes');
  return [
    `works with: ${worksWith.map((t) => t.technology).join(', ')}`,
    ...sharedPurpose.map((t) => `shares [${t.sharedPurposes.join(', ')}] with ${t.technology}`),
  ].join('\n');
});

await check('careerDiscovery(Python) (T1) discovers the showcase path', async () => {
  const paths = await graph.careerDiscovery('Python');
  assert(paths.length > 0, 'expected at least one path');
  const showcase = paths.find(
    (p) => arrow(p.steps) === 'Python → Machine Learning → PyTorch → ML Engineer',
  );
  assert(showcase, 'the Python→ML→PyTorch→ML Engineer path should be discovered');
  const distinctJobs = new Set(paths.map((p) => p.job));
  assert(distinctJobs.size > 1, 'one traversal should reach multiple careers');
  return paths.slice(0, 4).map((p) => arrow(p.steps)).join('\n');
});

await check('studyPath(Python) (T2) attaches courses where available', async () => {
  const reachable = await graph.studyPath('Python');
  const pytorch = reachable.find((t) => t.technology === 'PyTorch');
  assert(pytorch, 'PyTorch should be reachable from Python');
  assert(
    pytorch.courses.some((c) => c.name === 'PyTorch for Deep Learning Bootcamp'),
    'PyTorch should come with its bootcamp course',
  );
  assert(reachable.some((t) => t.courses.length === 0), 'techs without courses should still appear');
  return reachable
    .map((t) => `${t.technology}${t.courses.length ? ` ⇐ ${t.courses.map((c) => c.name).join('; ')}` : ' (no course seeded)'}`)
    .join('\n');
});

await check('employersForSkill(Python, core) (T4) filters on the edge property', async () => {
  const core = await graph.employersForSkill('Python', 'core');
  assert(core.some((c) => c.company === 'Google'), 'Google should appear for core Python');
  const nice = await graph.employersForSkill('Python', 'nice-to-have');
  assert(
    JSON.stringify(core) !== JSON.stringify(nice),
    'core and nice-to-have must produce different results',
  );
  return core.map((c) => `${c.company}: ${c.jobs.join(', ')}`).join('\n');
});

await check('employersForSkill rejects an invalid level', async () => {
  try {
    await graph.employersForSkill('Python', 'banana');
  } catch (err) {
    assert(err instanceof ValidationError, `expected ValidationError, got ${err.name}`);
    return err.message;
  }
  assert(false, 'no error was thrown');
});

// --- Connection Explorer ---------------------------------------------------

await check('shortestPath(Skill:Git → Company:Google) (T5) finds a 3-hop route', async () => {
  const path = await graph.shortestPath('Skill', 'Git', 'Company', 'Google');
  assert(path !== null, 'a path should exist');
  assert(path.relationships.length === 3, `expected 3 hops, got ${path.relationships.length}`);
  const names = path.nodes.map((n) => `${n.name} (${n.label})`).join(' → ');
  return `${names}\nedges: ${path.relationships.map((r) => `${r.from} -${r.type}-> ${r.to}`).join(', ')}`;
});

await check('shortestPath rejects identical endpoints', async () => {
  try {
    await graph.shortestPath('Skill', 'Git', 'Skill', 'Git');
  } catch (err) {
    assert(err instanceof ValidationError, `expected ValidationError, got ${err.name}`);
    return err.message;
  }
  assert(false, 'no error was thrown');
});

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(50)}\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
await closeDriver();
