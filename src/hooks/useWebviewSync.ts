import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspace } from "./useWorkspace";
import { flowNodeToWindowBounds, webviewContentArea } from "../lib/webviewBounds";
import type { WebviewRFNode } from "../types/workspace";

function getContainerOffset(): { left: number; top: number } {
  const el = document.querySelector(".canvas");
  if (!el) return { left: 0, top: 0 };
  const rect = el.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

/**
 * Keeps native child webviews glued to their placeholder React Flow nodes.
 * Repositioning happens live while dragging a single node (so it tracks
 * without perceptible delay), but only once a pan/zoom gesture settles —
 * recalculating every webview's bounds on every zoom frame is the jank risk
 * the spec calls out.
 */
export function useWebviewSync() {
  const viewport = useWorkspace((s) => s.viewport);

  const syncNode = useCallback(
    (node: WebviewRFNode) => {
      if (!node.data.webviewLabel) return;
      const contentArea = webviewContentArea(node.position, {
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      });
      const bounds = flowNodeToWindowBounds(
        contentArea.position,
        contentArea.size,
        viewport,
        getContainerOffset(),
      );
      void invoke("webview_update_bounds", {
        webviewLabel: node.data.webviewLabel,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    },
    [viewport],
  );

  const syncAllWebviews = useCallback(() => {
    for (const node of useWorkspace.getState().nodes) {
      if (node.type === "webview") syncNode(node);
    }
  }, [syncNode]);

  // Resizing the OS window changes the canvas's on-screen footprint without
  // touching any node's flow-space position, so it never fires onNodeDrag or
  // onMoveEnd — without this, native webview overlays go stale as soon as
  // the window is resized. A ResizeObserver (not the `resize` event) is
  // needed here: `resize` can fire before the browser has finished
  // reflowing, so a getBoundingClientRect() read at that instant can still
  // return the pre-resize box — ResizeObserver only fires once layout has
  // actually settled.
  //
  // A continuous window-resize drag fires ResizeObserver many times in
  // quick succession; syncing on every single one floods the IPC round trip
  // to the GTK main thread and visibly lags behind the gesture. Debounce to
  // one sync shortly after the resize settles, same trade-off the spec
  // already makes for pan/zoom.
  const resizeTimeoutRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const el = document.querySelector(".canvas");
    if (!el) return;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = window.setTimeout(() => syncAllWebviews(), 120);
    });
    observer.observe(el);
    return () => {
      window.clearTimeout(resizeTimeoutRef.current);
      observer.disconnect();
    };
  }, [syncAllWebviews]);

  return { syncNode, syncAllWebviews };
}
