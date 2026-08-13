import * as graph from '../services/graph.service.js';
import { requireQuery } from './validate.js';

// GET /api/search?q=term
export async function search(req, res) {
  const results = await graph.searchEntities(requireQuery(req, 'q'));
  res.json({ results });
}

// GET /api/stats
export async function stats(req, res) {
  res.json(await graph.getGraphStats());
}

// GET /api/entities/:label/:name
export async function getEntity(req, res) {
  res.json(await graph.getEntity(req.params.label, req.params.name));
}

// GET /api/entities/:label/:name/relationships
export async function getEntityRelationships(req, res) {
  const relationships = await graph.getEntityRelationships(req.params.label, req.params.name);
  res.json({ relationships });
}
