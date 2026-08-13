// Repeatable end-to-end API test.
//
//   npm run test:api
//     Spawns the real server on a test port, exercises every endpoint over
//     HTTP, then spawns a second server pointed at a dead database URI to
//     verify degraded behaviour. The live CognoDB instance is never touched
//     by that second part.
//
//   API_BASE_URL=https://techgraph-api.onrender.com npm run test:api
//     Runs the same assertions against an already-deployed backend. No
//     servers are spawned, so the database-unavailable checks are skipped
//     (they need a second process wired to a dead URI). Query semantics and
//     assertions are identical in both modes.
import { spawn } from 'node:child_process';

const REMOTE = process.env.API_BASE_URL?.replace(/\/$/, '') ?? null;
const LIVE_PORT = 4101;
const DEAD_PORT = 4102;
const live = (path) => (REMOTE ? `${REMOTE}/api${path}` : `http://localhost:${LIVE_PORT}/api${path}`);
const dead = (path) => `http://localhost:${DEAD_PORT}/api${path}`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function check(title, url, expectedStatus, verify) {
  try {
    const res = await fetch(url);
    assert(res.status === expectedStatus, `expected HTTP ${expectedStatus}, got ${res.status}`);
    const body = await res.json();
    const detail = verify ? verify(body) : undefined;
    passed += 1;
    console.log(`PASS  [${expectedStatus}] ${title}`);
    if (detail) console.log(detail.replace(/^/gm, '      '));
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${title}`);
    console.log(`      ${err.message}`);
  }
}

function startServer(port, extraEnv = {}) {
  return spawn(process.execPath, ['index.js'], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
}

// A server is "up" as soon as it answers HTTP at all — any status code.
// A deployed instance on a free tier may be asleep, so allow it far longer
// (up to ~2 minutes) to cold-start than a local process needs.
async function waitForServer(url, attempts = REMOTE ? 480 : 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Server at ${url} did not start`);
}

// Against a remote backend nothing is spawned locally.
const liveServer = REMOTE ? null : startServer(LIVE_PORT);
const deadServer = REMOTE ? null : startServer(DEAD_PORT, {
  COGNODB_URI: 'bolt://localhost:9999',
  COGNODB_USERNAME: 'nobody',
  COGNODB_PASSWORD: 'nothing',
});

try {
  console.log(REMOTE ? `Testing deployed backend: ${REMOTE}\n` : 'Testing local backend\n');
  await waitForServer(live('/health'));

  console.log('--- happy paths -------------------------------------------');
  await check('GET /live (liveness, no database call)', live('/live'), 200, (b) => {
    assert(b.status === 'ok', `expected status ok, got ${b.status}`);
    assert(b.service === 'techgraph-api', `expected service techgraph-api, got ${b.service}`);
    assert(!('database' in b), 'liveness must not report database state');
    return `status: ${b.status}, service: ${b.service}`;
  });
  await check('GET /health', live('/health'), 200, (b) => {
    assert(b.database === 'connected', `database should be connected, got ${b.database}`);
    return `database: ${b.database}`;
  });
  await check('GET /search?q=py', live('/search?q=py'), 200, (b) => {
    const names = b.results.map((r) => r.name);
    assert(names.includes('Python') && names.includes('PyTorch'), `got [${names}]`);
    return `${b.results.length} results`;
  });
  await check('GET /stats', live('/stats'), 200, (b) => {
    assert(b.totalNodes === 76 && b.totalRelationships === 185, 'counts should match seed');
    return `76 nodes / 185 relationships, top skill: ${b.topRequiredSkills[0].skill}`;
  });
  await check('GET /entities/Skill/Python', live('/entities/Skill/Python'), 200, (b) => {
    assert(b.label === 'Skill' && b.properties.name === 'Python', 'wrong entity');
    return `${b.label}: ${b.properties.name}`;
  });
  await check(
    'GET /entities/Skill/CI%2FCD (slash inside a name)',
    live(`/entities/Skill/${encodeURIComponent('CI/CD')}`),
    200,
    (b) => `${b.label}: ${b.properties.name}`,
  );
  await check(
    'GET /entities/Technology/PyTorch/relationships',
    live('/entities/Technology/PyTorch/relationships'),
    200,
    (b) => {
      assert(Array.isArray(b.relationships) && b.relationships.length >= 4, 'expected grouped relationships');
      return b.relationships.map((g) => `${g.type} (${g.direction}): ${g.entities.length}`).join(', ');
    },
  );
  await check('GET /jobs/requiring/Python', live('/jobs/requiring/Python'), 200, (b) => {
    assert(b.jobs.some((j) => j.job === 'ML Engineer' && j.requirement === 'core'), 'ML Engineer core missing');
    return b.jobs.map((j) => `${j.job} (${j.requirement})`).join(', ');
  });
  await check('GET /technologies/PyTorch/related', live('/technologies/PyTorch/related'), 200, (b) => {
    assert(b.worksWith.length > 0 && b.sharedPurpose.length > 0, 'both flavors expected');
    return `worksWith: ${b.worksWith.map((t) => t.technology).join(', ')} | sharedPurpose: ${b.sharedPurpose.map((t) => t.technology).join(', ')}`;
  });
  await check('GET /career-path?skill=Python (T1)', live('/career-path?skill=Python'), 200, (b) => {
    const showcase = b.paths.find(
      (p) => p.steps.map((s) => s.name).join(' → ') === 'Python → Machine Learning → PyTorch → ML Engineer',
    );
    assert(showcase, 'showcase path missing');
    return `${b.paths.length} paths, incl. Python → Machine Learning → PyTorch → ML Engineer`;
  });
  await check('GET /study-path?skill=Python (T2)', live('/study-path?skill=Python'), 200, (b) => {
    assert(b.technologies.some((t) => t.technology === 'PyTorch' && t.courses.length > 0), 'PyTorch + course expected');
    return `${b.technologies.length} reachable technologies`;
  });
  await check(
    'GET /employers-for-skill?skill=Python&level=core (T4)',
    live('/employers-for-skill?skill=Python&level=core'),
    200,
    (b) => {
      assert(b.employers.some((c) => c.company === 'Google'), 'Google expected');
      return b.employers.map((c) => c.company).join(', ');
    },
  );
  await check(
    'GET /connection-path Git→Google (T5)',
    live('/connection-path?fromLabel=Skill&fromName=Git&toLabel=Company&toName=Google'),
    200,
    (b) => {
      assert(b.path && b.path.relationships.length === 3, 'expected a 3-hop path');
      return b.path.nodes.map((n) => n.name).join(' → ');
    },
  );

  console.log('--- career builder ----------------------------------------');
  await check(
    'builder: all core skills already covered',
    live('/career-builder?skills=Python&skills=Machine+Learning&job=ML+Engineer'),
    200,
    (b) => {
      assert(b.requirements.core.missing.length === 0, 'no core gaps expected');
      assert(b.requirements.core.covered.length === 2, 'both core skills covered');
      assert(b.routes.length === 0, 'no routes needed when nothing is missing');
      return `core covered ${b.requirements.core.covered.length}/2, gaps: none`;
    },
  );
  await check(
    'builder: partial coverage discovers a learning route',
    live('/career-builder?skills=Python&skills=SQL&job=ML+Engineer'),
    200,
    (b) => {
      const gap = b.requirements.core.missing.map((g) => g.skill);
      assert(gap.length === 1 && gap[0] === 'Machine Learning', `expected [Machine Learning], got [${gap}]`);
      const route = b.routes.find((r) => r.skill === 'Machine Learning');
      assert(route && route.route.join(' → ') === 'Python → Machine Learning', 'route should be Python → Machine Learning');
      assert(b.requirements.niceToHave.covered.some((s) => s.skill === 'SQL'), 'SQL covers a nice-to-have');
      return `core gap: ${gap[0]}; route: ${route.route.join(' → ')}`;
    },
  );
  await check(
    'builder: no overlapping skills, no route available',
    live('/career-builder?skills=Git&job=Data+Scientist'),
    200,
    (b) => {
      assert(b.requirements.core.covered.length === 0, 'nothing covered');
      assert(b.requirements.core.missing.length === 3, 'three core gaps');
      assert(b.routes.length === 0, 'Git has no LEADS_TO route to any gap');
      return `0/3 core covered, routes: none (honest fresh start)`;
    },
  );
  await check(
    'builder: gap with no course keeps an explicit empty list',
    live('/career-builder?skills=Python&skills=SQL&job=Data+Engineer'),
    200,
    (b) => {
      const modeling = b.gapCourses.find((g) => g.skill === 'Data Modeling');
      assert(modeling && modeling.courses.length === 0, 'Data Modeling should have zero courses');
      const route = b.routes.find((r) => r.skill === 'Data Modeling');
      assert(route, 'a route to Data Modeling should exist (SQL leads to it)');
      return `Data Modeling: route ${route.route.join(' → ')}, courses: [] (empty state)`;
    },
  );
  await check('builder: unknown job', live('/career-builder?skills=Python&job=Nope'), 404, (b) => b.error);
  await check('builder: empty skill selection', live('/career-builder?job=ML+Engineer'), 400, (b) => b.error);
  await check('builder: unknown skill in selection', live('/career-builder?skills=Wizardry&job=ML+Engineer'), 404, (b) => b.error);

  console.log('--- empty results (valid, not errors) ---------------------');
  await check('GET /search?q=zzzzzz → empty list', live('/search?q=zzzzzz'), 200, (b) => {
    assert(b.results.length === 0, 'expected no results');
    return 'results: []';
  });

  console.log('--- invalid input → 400 -----------------------------------');
  await check('GET /search without q', live('/search'), 400, (b) => b.error);
  await check('GET /entities/Wizard/Python (bad label)', live('/entities/Wizard/Python'), 400, (b) => b.error);
  await check('GET /career-path without skill', live('/career-path'), 400, (b) => b.error);
  await check(
    'GET /employers-for-skill with bad level',
    live('/employers-for-skill?skill=Python&level=banana'),
    400,
    (b) => b.error,
  );
  await check(
    'GET /connection-path with identical endpoints',
    live('/connection-path?fromLabel=Skill&fromName=Git&toLabel=Skill&toName=Git'),
    400,
    (b) => b.error,
  );
  await check(
    'GET /connection-path with missing params',
    live('/connection-path?fromLabel=Skill&fromName=Git'),
    400,
    (b) => b.error,
  );

  console.log('--- unknown entities → 404 --------------------------------');
  await check('GET /entities/Skill/Nope', live('/entities/Skill/Nope'), 404, (b) => b.error);
  await check('GET /jobs/requiring/Nope', live('/jobs/requiring/Nope'), 404, (b) => b.error);
  await check('GET /api/no-such-route', live('/no-such-route'), 404, (b) => b.error);

  if (REMOTE) {
    console.log('--- database unavailable → 503 ----------------------------');
    console.log('SKIP  requires a locally spawned server wired to a dead database URI');
  } else {
    console.log('--- database unavailable → 503 (simulated safely) ---------');
    await waitForServer(dead('/live'));
    // The point of the split: liveness stays 200 while the database is down,
    // so the platform health check keeps the instance in rotation.
    await check('GET /live (dead DB) stays 200', dead('/live'), 200, (b) => {
      assert(b.status === 'ok', `expected status ok, got ${b.status}`);
      return `status: ${b.status} — instance stays in rotation`;
    });
    await check('GET /health (dead DB)', dead('/health'), 503, (b) => {
      assert(b.database === 'unreachable', `expected unreachable, got ${b.database}`);
      return `database: ${b.database}`;
    });
    await check('GET /search?q=py (dead DB)', dead('/search?q=py'), 503, (b) => {
      assert(!/at\s+\w+.*\(/.test(b.error), 'error message must not look like a stack trace');
      return b.error;
    });
  }
} finally {
  liveServer?.kill();
  deadServer?.kill();
}

console.log(`\n${'='.repeat(50)}\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
