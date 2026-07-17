import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { WebviewRFNode } from "../../types/workspace";
import { ResourceTray } from "./ResourceTray";
import "./WebviewNode.css";

/**
 * Purely a visual placeholder. The real page is a native child webview
 * overlaid on top at the same screen coordinates (see useWebviewSync) — this
 * component owns no webview lifecycle itself, only the chrome around it.
 *
 * The native overlay covers the body, so anything interactive (the capture
 * button, the resource tray) must live in the titlebar, which the overlay is
 * inset below.
 */
export function WebviewNode({ id, data }: NodeProps<WebviewRFNode>) {
  const removeNode = useWorkspace((s) => s.removeNode);
  const respawnNode = useWorkspace((s) => s.respawnNode);
  const captureWebview = useWorkspace((s) => s.captureWebview);

  return (
    <div className="webview-node">
      {/* An agent wires to this Portal (either direction) to capture it. */}
      <Handle type="target" position={Position.Left} />
      <div className="webview-node__titlebar">
        <span className="webview-node__label">{data.label}</span>
        {/* Screenshots this Portal owns, inline so they clear the overlay. */}
        <ResourceTray nodeId={id} inline />
        <div className="webview-node__actions">
          {data.webviewLabel !== null && (
            <button
              type="button"
              className="nodrag"
              onClick={() => void captureWebview(id)}
              title="Capture screenshot"
            >
              📷
            </button>
          )}
          {data.webviewLabel === null && (
            <button type="button" onClick={() => respawnNode(id)} title="Respawn">
              ⟲
            </button>
          )}
          <button type="button" onClick={() => removeNode(id)} title="Close">
            ×
          </button>
        </div>
      </div>
      <div className="webview-node__body">
        {data.webviewLabel === null && (
          <div className="webview-node__placeholder">disconnected — click ⟲ to respawn</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
