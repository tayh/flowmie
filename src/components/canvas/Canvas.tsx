import { useCallback } from "react";
import { Background, Controls, ReactFlow, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useWebviewSync } from "../../hooks/useWebviewSync";
import { TerminalNode } from "./TerminalNode";
import { WebviewNode } from "./WebviewNode";
import { NewNodeMenu } from "../toolbar/NewNodeMenu";
import { WorkspaceMenu } from "../toolbar/WorkspaceMenu";
import type { FlowmieRFNode, Viewport } from "../../types/workspace";
import "./Canvas.css";

const nodeTypes: NodeTypes = { terminal: TerminalNode, webview: WebviewNode };

export function Canvas() {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const nodes = useWorkspace((s) => s.nodes);
  const onNodesChange = useWorkspace((s) => s.onNodesChange);
  const viewport = useWorkspace((s) => s.viewport);
  const setViewport = useWorkspace((s) => s.setViewport);
  const addTerminal = useWorkspace((s) => s.addTerminal);
  const addWebview = useWorkspace((s) => s.addWebview);
  const { syncNode, syncAllWebviews } = useWebviewSync();

  const handleMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      setViewport(vp);
      syncAllWebviews();
    },
    [setViewport, syncAllWebviews],
  );

  const handleNodeDrag = useCallback(
    (_: unknown, node: FlowmieRFNode) => {
      if (node.type === "webview") syncNode(node);
    },
    [syncNode],
  );

  return (
    <div className="canvas">
      <ReactFlow
        key={workspaceId}
        nodes={nodes}
        edges={[]}
        onNodesChange={onNodesChange}
        onNodeDrag={handleNodeDrag}
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
        <NewNodeMenu
          onSelectAgent={(agentType) => void addTerminal(agentType)}
          onSelectWeb={(url, label) => void addWebview(url, label)}
        />
        <WorkspaceMenu />
      </div>
    </div>
  );
}
