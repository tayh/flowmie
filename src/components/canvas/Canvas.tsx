import { useCallback } from "react";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkspace } from "../../hooks/useWorkspace";
import { TerminalNode } from "./TerminalNode";
import { NewNodeMenu } from "../toolbar/NewNodeMenu";
import { WorkspaceMenu } from "../toolbar/WorkspaceMenu";
import type { Viewport } from "../../types/workspace";
import "./Canvas.css";

const nodeTypes: NodeTypes = { terminal: TerminalNode };

export function Canvas() {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const nodes = useWorkspace((s) => s.nodes);
  const onNodesChange = useWorkspace((s) => s.onNodesChange);
  const viewport = useWorkspace((s) => s.viewport);
  const setViewport = useWorkspace((s) => s.setViewport);
  const addTerminal = useWorkspace((s) => s.addTerminal);

  const handleMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => setViewport(vp),
    [setViewport],
  );

  return (
    <div className="canvas">
      <ReactFlow
        key={workspaceId}
        nodes={nodes}
        edges={[]}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        defaultViewport={viewport}
        onMoveEnd={handleMoveEnd}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background />
        <Controls />
      </ReactFlow>
      <div className="canvas__toolbar">
        <NewNodeMenu onSelect={(agentType) => void addTerminal(agentType)} />
        <WorkspaceMenu />
      </div>
    </div>
  );
}
