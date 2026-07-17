import { useCallback, type DragEvent } from "react";
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
import { useResources } from "../../hooks/useResources";
import { TerminalNode } from "./TerminalNode";
import { WebviewNode } from "./WebviewNode";
import { NoteNode } from "./NoteNode";
import { RelayEdge } from "./RelayEdge";
import { NewNodeMenu } from "../toolbar/NewNodeMenu";
import { WorkspaceMenu } from "../toolbar/WorkspaceMenu";
import type { FlowmieRFNode, ResourceKind, Viewport } from "../../types/workspace";
import "./Canvas.css";

/** The base64 payload of a dropped file, without the `data:...;base64,` prefix. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function kindForMime(mime: string): ResourceKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/")) return "text";
  return "file";
}

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
  const registerResource = useWorkspace((s) => s.registerResource);
  const { syncNode, syncAllWebviews } = useWebviewSync();
  useRelay();
  usePersistence();
  useSkillsSync();
  useSkillMessages();
  useResources();

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

  // Dropping OS files (images/text/etc.) onto the canvas registers them as
  // user-owned resources (ownerNodeId = null) any agent can then be handed.
  const handleCanvasDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  }, []);

  const handleCanvasDrop = useCallback(
    (e: DragEvent) => {
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      e.preventDefault();
      for (const file of files) {
        void fileToBase64(file).then((dataBase64) =>
          registerResource({
            kind: kindForMime(file.type),
            mime: file.type || "application/octet-stream",
            label: file.name,
            ownerNodeId: null,
            dataBase64,
          }),
        );
      }
    },
    [registerResource],
  );

  return (
    <div className="canvas" onDragOver={handleCanvasDragOver} onDrop={handleCanvasDrop}>
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
