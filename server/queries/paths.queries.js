// Query behind the Connection Explorer.

// T5 — shortest path between two explicitly identified entities. Endpoints
// are always (label, name) pairs — never a bare name, which could be
// ambiguous across labels. The hop cap (6) keeps the search bounded on the
// free tier; the graph is deliberately dense enough that meaningful pairs
// connect well within it.
//
// Each relationship is returned with its stored from/to node names so the
// client can draw true arrow directions even though the path itself is
// matched undirected.
export const SHORTEST_PATH = `
MATCH (a) WHERE $fromLabel IN labels(a) AND a.name = $fromName
MATCH (b) WHERE $toLabel  IN labels(b) AND b.name = $toName
MATCH p = shortestPath((a)-[*..6]-(b))
RETURN [n IN nodes(p) | {label: labels(n)[0], name: n.name, description: n.description}] AS nodes,
       [r IN relationships(p) | {type: type(r), from: startNode(r).name, to: endNode(r).name}] AS relationships`;
