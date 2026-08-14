const EDGE_INDICES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const FACE_EDGE_MAP = {
  face_x_pos: [1, 2, 9, 10],
  face_x_neg: [3, 0, 11, 8],
  face_z_pos: [2, 3, 10, 11],
  face_z_neg: [0, 1, 8, 9],
  face_y_pos: [4, 5, 6, 7],
  face_y_neg: [0, 1, 2, 3],
};

export const StretchEditor = ({ screenGeometry, hoveredHandleId, isStretching }) => {
  if (!screenGeometry) return null;
  const { corners, handles, width, height } = screenGeometry;
  if (corners.some(c => !c) || handles.some(h => !h.screenPos)) return null;

  const highlightedEdges = new Set(
    hoveredHandleId && FACE_EDGE_MAP[hoveredHandleId] ? FACE_EDGE_MAP[hoveredHandleId] : []
  );

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 20 }}
    >
      {EDGE_INDICES.map(([a, b], i) => {
        const isHighlighted = highlightedEdges.has(i);
        return (
          <line
            key={`edge-${i}`}
            x1={corners[a][0]}
            y1={corners[a][1]}
            x2={corners[b][0]}
            y2={corners[b][1]}
            stroke={isHighlighted ? '#22d3ee' : 'rgba(255,255,255,0.65)'}
            strokeWidth={isHighlighted ? 2 : 1}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}

      {handles.filter(h => h.type === 'face').map(h => {
        const isHovered = hoveredHandleId === h.id;
        return (
          <rect
            key={h.id}
            x={h.screenPos[0] - 5}
            y={h.screenPos[1] - 5}
            width={10}
            height={10}
            rx={2}
            fill={isHovered ? '#22d3ee' : '#0f172a'}
            stroke="#ffffff"
            strokeWidth={1}
          />
        );
      })}

      {handles.filter(h => h.type === 'corner').map(h => (
        <rect
          key={h.id}
          x={h.screenPos[0] - 4}
          y={h.screenPos[1] - 4}
          width={8}
          height={8}
          fill="#0f172a"
          stroke="rgba(255,255,255,0.85)"
          strokeWidth={1}
          opacity={0.85}
        />
      ))}

      {isStretching && (
        <text
          x={width / 2}
          y={16}
          textAnchor="middle"
          fill="#22d3ee"
          fontSize={11}
          fontFamily="monospace"
        >
          stretching
        </text>
      )}
    </svg>
  );
};
