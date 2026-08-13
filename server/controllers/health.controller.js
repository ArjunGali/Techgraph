import { checkConnectivity } from '../config/db.js';

// Liveness only: "is this process up and serving HTTP?". It touches nothing
// external — no database call, no network I/O — so it cannot fail because a
// dependency is slow or down. This is the endpoint the hosting platform's
// health check should poll: a dependency-aware check there would deregister
// a perfectly healthy API whenever the database blipped, taking every route
// offline with it.
export function live(req, res) {
  res.json({ status: 'ok', service: 'techgraph-api' });
}

// Reports API liveness and database connectivity separately, so the client
// (and an operator) can tell "API down" apart from "database down".
// database is one of: 'connected' | 'not_configured' | 'unreachable'.
export async function health(req, res) {
  const db = await checkConnectivity();
  res.status(db.connected ? 200 : 503).json({
    status: db.connected ? 'ok' : 'degraded',
    service: 'techgraph-api',
    database: db.connected ? 'connected' : db.reason,
  });
}
