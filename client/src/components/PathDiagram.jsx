import { LABEL_STYLES, truncate } from '../utils/labels.js';

// Hand-rolled SVG path renderer: nodes left to right, one edge between each
// pair, relationship type above the edge. `edges[i].direction` controls the
// arrowhead: 'forward' | 'backward' (the true stored direction, used by the
// Connection Explorer) — the Career Path passes 'forward' for every hop and
// captions the diagram as learning order. Wide paths scroll horizontally
// inside their container instead of squashing.
export default function PathDiagram({ nodes, edges }) {
  const SPACING = 195;
  const X0 = 90;
  const H = 150;
  const Y = 62;
  const width = X0 * 2 + SPACING * (nodes.length - 1);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${H}`}
        style={{ minWidth: `${Math.min(width, 900)}px` }}
        className="mx-auto h-auto"
        role="img"
        aria-label={`Path: ${nodes.map((n) => n.name).join(', then ')}`}
      >
        <defs>
          <marker id="path-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#818cf8" />
          </marker>
        </defs>

        {edges.map((edgeInfo, i) => {
          const x1 = X0 + i * SPACING + 22;
          const x2 = X0 + (i + 1) * SPACING - 22;
          const backward = edgeInfo.direction === 'backward';
          return (
            <g key={`edge-${i}`}>
              <line
                x1={x1} y1={Y} x2={x2} y2={Y}
                stroke="#4f46e5" strokeWidth="2" opacity="0.7"
                markerEnd={backward ? undefined : 'url(#path-arrow)'}
                markerStart={backward ? 'url(#path-arrow)' : undefined}
              />
              <text x={(x1 + x2) / 2} y={Y - 12} textAnchor="middle" fontSize="10" fill="#94a3b8" className="uppercase">
                {edgeInfo.label}
              </text>
            </g>
          );
        })}

        {nodes.map((node, i) => {
          const x = X0 + i * SPACING;
          return (
            <g key={`node-${i}`}>
              <title>{`${node.name} (${node.label})`}</title>
              <circle cx={x} cy={Y} r="17" fill={LABEL_STYLES[node.label]?.dot ?? '#94a3b8'} />
              <text x={x} y={Y + 40} textAnchor="middle" fontSize="13" fontWeight="600" fill="#e2e8f0">
                {truncate(node.name, 20)}
              </text>
              <text x={x} y={Y + 57} textAnchor="middle" fontSize="10" fill="#64748b">
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
