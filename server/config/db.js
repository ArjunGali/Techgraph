import neo4j from 'neo4j-driver';

// One driver instance for the whole process: the driver owns a connection
// pool and is expensive to create, while sessions are cheap and short-lived.
// Created lazily so the server can boot (and report a helpful health status)
// even when CognoDB is not configured yet.
let driver = null;

export function isConfigured() {
  return Boolean(
    process.env.COGNODB_URI && process.env.COGNODB_USERNAME && process.env.COGNODB_PASSWORD,
  );
}

export function getDriver() {
  if (!driver) {
    if (!isConfigured()) {
      throw new Error(
        'CognoDB is not configured: set COGNODB_URI, COGNODB_USERNAME and COGNODB_PASSWORD (see server/.env.example).',
      );
    }
    driver = neo4j.driver(
      process.env.COGNODB_URI,
      neo4j.auth.basic(process.env.COGNODB_USERNAME, process.env.COGNODB_PASSWORD),
      {
        // Return plain JS numbers instead of the driver's lossless Integer
        // objects — every number in this graph is far below 2^53.
        disableLosslessIntegers: true,
        // Fail fast when the database is unreachable instead of queueing
        // requests forever; the API turns this into a clear 503.
        connectionTimeout: 10_000,
        connectionAcquisitionTimeout: 10_000,
        // executeRead retries ServiceUnavailable errors; the default budget
        // (30s) leaves users staring at a spinner when the database is down.
        // 5s still absorbs transient blips but degrades quickly to a 503.
        maxTransactionRetryTime: 5_000,
      },
    );
  }
  return driver;
}

// All application queries are read-only; routing the session as READ lets a
// clustered database serve them from any member.
export async function readQuery(cypher, params = {}) {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) => tx.run(cypher, params));
    return result.records;
  } finally {
    await session.close();
  }
}

// Used only by the seed script.
export async function writeQuery(cypher, params = {}) {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    return await session.executeWrite((tx) => tx.run(cypher, params));
  } finally {
    await session.close();
  }
}

export async function checkConnectivity() {
  if (!isConfigured()) {
    return { connected: false, reason: 'not_configured' };
  }
  try {
    await getDriver().verifyConnectivity();
    return { connected: true };
  } catch (err) {
    console.error('CognoDB connectivity check failed:', err.message);
    return { connected: false, reason: 'unreachable' };
  }
}

export async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
