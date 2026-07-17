import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useWorkspace } from "./useWorkspace";
import { windowPointToFlowPosition } from "../lib/webviewBounds";

/** Cascade offset so a multi-file drop doesn't stack nodes exactly on top. */
const DROP_CASCADE = 24;

function getContainerOffset(): { left: number; top: number } {
  const el = document.querySelector(".canvas");
  if (!el) return { left: 0, top: 0 };
  const rect = el.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

/**
 * Turns an OS file/folder drop into file nodes at the drop point (F003).
 *
 * This uses Tauri's **native** drag-drop rather than an HTML5 `drop` listener,
 * for two independent reasons:
 *  - An HTML5 drop hands back a sandboxed `File` with **no path**, and a file
 *    node is a live path. `FileReader` could only ever give us bytes — that's
 *    the copy-a-blob model F002 already has, not this one.
 *  - `dragDropEnabled` defaults to true, so Tauri consumes OS drops natively
 *    and the webview never fires the HTML5 `drop` at all.
 *
 * Internal HTML5 drags (the resource chips) are unaffected — those never leave
 * the webview, so Tauri's OS-level handler doesn't see them.
 *
 * Mounted once in Canvas.
 */
export function useFileDrop() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        if (!paths || paths.length === 0) return;

        // `position` is physical, window-relative; the store thinks in flow space.
        const { viewport, addFile } = useWorkspace.getState();
        const dropAt = windowPointToFlowPosition(
          position,
          viewport,
          getContainerOffset(),
          window.devicePixelRatio,
        );

        paths.forEach((path, i) => {
          void addFile(path, {
            x: dropAt.x + i * DROP_CASCADE,
            y: dropAt.y + i * DROP_CASCADE,
          });
        });
      })
      .then((fn) => {
        // The listener may resolve after unmount; drop it immediately if so.
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
