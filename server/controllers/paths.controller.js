import * as graph from '../services/graph.service.js';
import { requireQuery } from './validate.js';

// GET /api/connection-path?fromLabel=Skill&fromName=Git&toLabel=Company&toName=Google  (T5)
// "No path within the hop cap" is a valid outcome, not an error: the
// response is 200 with { path: null } and the client renders an empty state.
export async function connectionPath(req, res) {
  const path = await graph.shortestPath(
    requireQuery(req, 'fromLabel'),
    requireQuery(req, 'fromName'),
    requireQuery(req, 'toLabel'),
    requireQuery(req, 'toName'),
  );
  res.json({ path });
}
