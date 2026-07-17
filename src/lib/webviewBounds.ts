export interface FlowPosition {
  x: number;
  y: number;
}

export interface FlowSize {
  width: number;
  height: number;
}

export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ContainerOffset {
  left: number;
  top: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts a React Flow node's logical position/size into absolute window
 * (logical/CSS pixel) coordinates for positioning a native child webview.
 *
 * React Flow maps flow-space points to on-screen points within its
 * container via `screen = flow * zoom + viewport`. The container can itself
 * be offset from the window's origin, so that offset is added last to land
 * in window-space, which is what Tauri's webview_update_bounds expects.
 */
export function flowNodeToWindowBounds(
  position: FlowPosition,
  size: FlowSize,
  viewport: FlowViewport,
  containerOffset: ContainerOffset,
): WindowBounds {
  return {
    x: position.x * viewport.zoom + viewport.x + containerOffset.left,
    y: position.y * viewport.zoom + viewport.y + containerOffset.top,
    width: size.width * viewport.zoom,
    height: size.height * viewport.zoom,
  };
}

/**
 * The inverse of {@link flowNodeToWindowBounds} for a point: turns a **physical**
 * window pixel (what Tauri's native drag-drop event reports) into a flow-space
 * position, so a dropped file lands under the cursor (F003).
 *
 * Two conversions, in order, and both matter:
 *  1. physical → logical/CSS pixels, dividing by the device pixel ratio — on a
 *     HiDPI screen (ratio 2) skipping this drops the node at twice the offset.
 *  2. logical window point → flow space, inverting `screen = flow * zoom + viewport`
 *     after removing the container's own offset from the window origin.
 */
export function windowPointToFlowPosition(
  point: FlowPosition,
  viewport: FlowViewport,
  containerOffset: ContainerOffset,
  devicePixelRatio: number,
): FlowPosition {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const logicalX = point.x / ratio;
  const logicalY = point.y / ratio;
  return {
    x: (logicalX - containerOffset.left - viewport.x) / viewport.zoom,
    y: (logicalY - containerOffset.top - viewport.y) / viewport.zoom,
  };
}

/**
 * Must match the fixed height of .webview-node__titlebar in
 * WebviewNode.css. The native overlay sits on top of everything in its
 * bounds, so it has to be inset below the titlebar or it hides it entirely.
 */
export const WEBVIEW_TITLEBAR_HEIGHT = 28;

/** The webview-node's content area (below its titlebar), in flow space. */
export function webviewContentArea(
  position: FlowPosition,
  size: FlowSize,
): { position: FlowPosition; size: FlowSize } {
  return {
    position: { x: position.x, y: position.y + WEBVIEW_TITLEBAR_HEIGHT },
    size: { width: size.width, height: Math.max(0, size.height - WEBVIEW_TITLEBAR_HEIGHT) },
  };
}
