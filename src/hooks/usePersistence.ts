import { useEffect, useRef } from "react";
import { useWorkspace } from "./useWorkspace";

/**
 * Ties the workspace to disk so closing and reopening the app restores
 * everything: auto-loads the most recently saved workspace on startup
 * (which respawns terminals and recreates webviews), and debounce-saves on
 * every structural change thereafter. Mounted once in Canvas.
 */
export function usePersistence() {
  const initializedRef = useRef(false);
  const saveTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const summaries = await useWorkspace.getState().listWorkspaces();
        // workspace_list is sorted newest-first.
        if (!cancelled && summaries.length > 0) {
          await useWorkspace.getState().loadWorkspace(summaries[0].id);
        }
      } catch {
        // No saved workspaces (or load failed) — start with a blank canvas.
      } finally {
        if (!cancelled) initializedRef.current = true;
      }
    })();

    const unsubscribe = useWorkspace.subscribe((state, prev) => {
      if (!initializedRef.current) return;
      // Only persist structural/content/viewport/resource changes.
      if (
        state.nodes === prev.nodes &&
        state.edges === prev.edges &&
        state.viewport === prev.viewport &&
        state.resources === prev.resources
      ) {
        return;
      }
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void useWorkspace.getState().saveWorkspace();
      }, 1000);
    });

    return () => {
      cancelled = true;
      unsubscribe();
      window.clearTimeout(saveTimerRef.current);
    };
  }, []);
}
