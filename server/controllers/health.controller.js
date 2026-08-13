import { checkConnectivity } from '../config/db.js';

// Reports API liveness and database connectivity separately, so the client
// (and the hosting platform) can tell "API down" apart from "database down".
// database is one of: 'connected' | 'not_configured' | 'unreachable'.
export async function health(req, res) {
  const db = await checkConnectivity();
  res.status(db.connected ? 200 : 503).json({
    status: db.connected ? 'ok' : 'degraded',
    service: 'techgraph-api',
    database: db.connected ? 'connected' : db.reason,
  });
}
