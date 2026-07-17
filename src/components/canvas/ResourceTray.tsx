import type { DragEvent } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { ResourceKind } from "../../types/workspace";
import "./ResourceTray.css";

/** Custom MIME carried on a chip drag so only resource drops are accepted. */
export const RESOURCE_DRAG_MIME = "application/x-flowmie-resource";

const KIND_ICON: Record<ResourceKind, string> = {
  image: "🖼",
  text: "📝",
  file: "📎",
};

/**
 * The chips for one node's resources (F002 Phase 3). Owner-scoped: shows the
 * resources this node produced. A chip is draggable onto another node to
 * re-share it (see `useResourceDropTarget`), click-opens its on-disk blob, and
 * carries an × to drop it from the canvas.
 */
export function ResourceTray({ nodeId, inline }: { nodeId: string; inline?: boolean }) {
  // Select the stable array and filter in render (never return a fresh array
  // from the selector — that defeats zustand's reference equality).
  const allResources = useWorkspace((s) => s.resources);
  const removeResource = useWorkspace((s) => s.removeResource);
  const resources = allResources.filter((r) => r.ownerNodeId === nodeId);

  if (resources.length === 0) return null;

  return (
    <div className={`resource-tray nodrag nopan${inline ? " resource-tray--inline" : ""}`}>
      {resources.map((r) => (
        <div
          key={r.id}
          className="resource-chip"
          draggable
          title={`${r.label}\n${r.path || "(live)"}`}
          onDragStart={(e) => {
            e.dataTransfer.setData(RESOURCE_DRAG_MIME, r.id);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => {
            // Open the blob in the OS default app; live/note resources (no path)
            // have nothing to open.
            if (r.path) void openPath(r.path);
          }}
        >
          <span className="resource-chip__icon">{KIND_ICON[r.kind] ?? "📎"}</span>
          <span className="resource-chip__label">{r.label}</span>
          <button
            type="button"
            className="resource-chip__remove"
            title="Remove from canvas"
            onClick={(e) => {
              e.stopPropagation();
              removeResource(r.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Drop-target handlers that re-share a dragged resource chip onto `nodeId`, so
 * that node's agent can then `get_resource` it. Spread onto a node's root.
 */
export function useResourceDropTarget(nodeId: string) {
  const reshareResource = useWorkspace((s) => s.reshareResource);
  return {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(RESOURCE_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    },
    onDrop: (e: DragEvent) => {
      const resourceId = e.dataTransfer.getData(RESOURCE_DRAG_MIME);
      if (!resourceId) return;
      e.preventDefault();
      e.stopPropagation();
      void reshareResource(resourceId, nodeId);
    },
  };
}
