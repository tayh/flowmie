import type { NodeProps } from "@xyflow/react";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { WebviewRFNode } from "../../types/workspace";
import "./WebviewNode.css";

/**
 * Purely a visual placeholder. The real page is a native child webview
 * overlaid on top at the same screen coordinates (see useWebviewSync) — this
 * component owns no webview lifecycle itself, only the chrome around it.
 */
export function WebviewNode({ id, data }: NodeProps<WebviewRFNode>) {
  const removeNode = useWorkspace((s) => s.removeNode);
  const respawnNode = useWorkspace((s) => s.respawnNode);

  return (
    <div className="webview-node">
      <div className="webview-node__titlebar">
        <span className="webview-node__label">{data.label}</span>
        <div className="webview-node__actions">
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
    </div>
  );
}
