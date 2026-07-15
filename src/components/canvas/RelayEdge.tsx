import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useSkillActivity } from "../../hooks/useSkillActivity";
import type { FlowmieEdge } from "../../types/workspace";
import "./RelayEdge.css";

export function RelayEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FlowmieEdge>) {
  const toggleEdge = useWorkspace((s) => s.toggleEdge);
  const toggleEdgeDirection = useWorkspace((s) => s.toggleEdgeDirection);
  const enabled = data?.enabled ?? true;
  const bidirectional = data?.direction === "bidirectional";
  const active = useSkillActivity((s) => Boolean(s.activeEdges[id]));

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className={active ? "relay-edge__path--active" : undefined}
        style={{
          stroke: enabled ? "#4aa3ff" : "#666",
          strokeWidth: 2,
          strokeDasharray: enabled ? undefined : "5 4",
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="relay-edge__controls"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button
            type="button"
            className="relay-edge__toggle"
            onClick={() => toggleEdgeDirection(id)}
            title={
              bidirectional
                ? "Two-way — replies flow back. Click for one-way."
                : "One-way (source → target). Click for two-way so replies flow back."
            }
          >
            {bidirectional ? "⇄" : "→"}
          </button>
          <button
            type="button"
            className={`relay-edge__toggle${enabled ? "" : " relay-edge__toggle--off"}`}
            onClick={() => toggleEdge(id)}
            title={enabled ? "Relay on — click to disable" : "Relay off — click to enable"}
          >
            {enabled ? "on" : "off"}
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
