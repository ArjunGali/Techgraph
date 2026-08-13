import { useState } from 'react';
import { LABEL_STYLES, truncate } from '../utils/labels.js';

// Hand-rolled SVG neighborhood view: the selected entity in the center, its
// one-hop neighbors on an ellipse around it. The layout is deterministic —
// neighbor i sits at angle i · 2π/n starting at 12 o'clock — so the same
// data always draws the same picture. Arrowheads show the true stored
// direction of each relationship (marker-end for outgoing, a reversed
// marker-start for incoming). Everything drawn comes straight from the
// /relationships API response.
export default function NeighborhoodGraph({ center, groups, onSelect }) {
  // A focused SVG <g> does not reliably match CSS :focus in Chromium, so the
  // keyboard focus ring is tracked here and drawn as a stroke.
  const [focused, setFocused] = useState(null);
  const neighbors = groups.flatMap((group) =>
    group.entities.map((entity) => ({ ...entity, type: group.type, outgoing: group.direction === 'outgoing' })),
  );
  if (neighbors.length === 0) return null;

  const W = 860;
  const H = 600;
  const cx = W / 2;
  const cy = H / 2;
  const rx = 330;
  const ry = 225;

  const placed = neighbors.map((neighbor, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / neighbors.length;
    return { ...neighbor, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });

  // Trim each edge so arrowheads land on node borders, not node centers.
  // Edge labels alternate between two positions along the line so adjacent
  // labels don't stack on top of each other in dense neighborhoods.
  const edge = (node, index) => {
    const dx = node.x - cx;
    const dy = node.y - cy;
    const dist = Math.hypot(dx, dy);
    const ux = dx / dist;
    const uy = dy / dist;
    const labelFraction = 0.48 + (index % 2) * 0.2;
    return {
      x1: cx + ux * 34, y1: cy + uy * 34,
      x2: node.x - ux * 22, y2: node.y - uy * 22,
      mx: cx + ux * (dist * labelFraction), my: cy + uy * (dist * labelFraction),
    };
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Relationships of ${center.name}: ${neighbors.length} connected entities`}
    >
      <defs>
        <marker id="arrow-out" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
        </marker>
        <marker id="arrow-in" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
        </marker>
      </defs>

      {placed.map((node, index) => {
        const line = edge(node, index);
        return (
          <g key={`edge-${node.label}-${node.name}`}>
            <line
              x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}
              stroke="#334155" strokeWidth="1.5"
              markerEnd={node.outgoing ? 'url(#arrow-out)' : undefined}
              markerStart={node.outgoing ? undefined : 'url(#arrow-in)'}
            />
            <text x={line.mx} y={line.my - 5} textAnchor="middle" fontSize="9.5" fill="#64748b" className="uppercase">
              {node.type}
            </text>
          </g>
        );
      })}

      <g>
        <circle cx={cx} cy={cy} r="30" fill={LABEL_STYLES[center.label]?.dot ?? '#94a3b8'} />
        <text x={cx} y={cy + 50} textAnchor="middle" fontSize="15" fontWeight="600" fill="#f1f5f9">
          {truncate(center.name, 24)}
        </text>
      </g>

      {placed.map((node) => {
        const key = `${node.label}:${node.name}:${node.type}`;
        return (
          <g
            key={`node-${key}`}
            onClick={() => onSelect(node)}
            onKeyDown={(event) => event.key === 'Enter' && onSelect(node)}
            onFocus={() => setFocused(key)}
            onBlur={() => setFocused(null)}
            role="button"
            tabIndex={0}
            aria-label={`Open ${node.name}`}
            className="cursor-pointer"
          >
            <title>{`${node.name} (${node.label})`}</title>
            <circle
              cx={node.x}
              cy={node.y}
              r="16"
              fill={LABEL_STYLES[node.label]?.dot ?? '#94a3b8'}
              opacity="0.9"
              stroke={focused === key ? '#e0e7ff' : 'none'}
              strokeWidth={focused === key ? 3 : 0}
            />
            <text x={node.x} y={node.y + 32} textAnchor="middle" fontSize="12" fill="#cbd5e1">
              {truncate(node.name)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
