import { useCallback } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useWebviewSync } from "../../hooks/useWebviewSync";
import { useRelay } from "../../hooks/useRelay";
import { usePersistence } from "../../hooks/usePersistence";
import { useSkillsSync } from "../../hooks/useSkillsSync";
import { useSkillMessages } from "../../hooks/useSkillActivity";
import { TerminalNode } from "./TerminalNode";
import { WebviewNode } from "./WebviewNode";
import { NoteNode } from "./NoteNode";
import { RelayEdge } from "./RelayEdge";
import { NewNodeMenu } from "../toolbar/NewNodeMenu";
import { WorkspaceMenu } from "../toolbar/WorkspaceMenu";
import type { FlowmieRFNode, Viewport } from "../../types/workspace";
import "./Canvas.css";

const nodeTypes: NodeTypes = {
  terminal: TerminalNode,
  webview: WebviewNode,
  note: NoteNode,
};
const edgeTypes: EdgeTypes = { relay: RelayEdge };

export function Canvas() {
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const nodes = useWorkspace((s) => s.nodes);
  const edges = useWorkspace((s) => s.edges);
  const onNodesChange = useWorkspace((s) => s.onNodesChange);
  const onEdgesChange = useWorkspace((s) => s.onEdgesChange);
  const onConnect = useWorkspace((s) => s.onConnect);
  const viewport = useWorkspace((s) => s.viewport);
  const setViewport = useWorkspace((s) => s.setViewport);
  const addTerminal = useWorkspace((s) => s.addTerminal);
  const addWebview = useWorkspace((s) => s.addWebview);
  const addNote = useWorkspace((s) => s.addNote);
  const { syncNode, syncAllWebviews } = useWebviewSync();
  useRelay();
  usePersistence();
  useSkillsSync();
  useSkillMessages();

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
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDrag={handleNodeDrag}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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
          onSelectRole={(instruction) => void addTerminal("claude", { role: instruction })}
          onAddNote={() => addNote()}
        />
        <WorkspaceMenu />
      </div>
    </div>
  );
}
