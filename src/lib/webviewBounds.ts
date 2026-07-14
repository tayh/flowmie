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
