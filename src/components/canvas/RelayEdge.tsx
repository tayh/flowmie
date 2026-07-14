import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { useWorkspace } from "../../hooks/useWorkspace";
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
  const enabled = data?.enabled ?? true;

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
        style={{
          stroke: enabled ? "#4aa3ff" : "#666",
          strokeWidth: 2,
          strokeDasharray: enabled ? undefined : "5 4",
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`relay-edge__toggle${enabled ? "" : " relay-edge__toggle--off"}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={() => toggleEdge(id)}
          title={enabled ? "Relay on — click to disable" : "Relay off — click to enable"}
        >
          {enabled ? "⇄ on" : "⇄ off"}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
