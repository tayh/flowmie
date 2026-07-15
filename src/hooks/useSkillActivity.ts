import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { useWorkspace } from "./useWorkspace";

interface SkillMessagePayload {
  fromNodeId: string;
  toNodeId: string;
  messageId: string;
}

interface SkillActivityState {
  /** edgeId → a token identifying the current flash (for expiry). */
  activeEdges: Record<string, number>;
  flash: (edgeId: string) => void;
}

const FLASH_MS = 1200;

/**
 * Tracks which relay edges are momentarily "lit" because a directed message
 * (F002 send_message) just crossed them, so RelayEdge can animate them.
 */
export const useSkillActivity = create<SkillActivityState>((set, get) => ({
  activeEdges: {},
  flash: (edgeId) => {
    const token = Date.now();
    set({ activeEdges: { ...get().activeEdges, [edgeId]: token } });
    window.setTimeout(() => {
      // Only clear if a newer flash hasn't superseded this one.
      if (get().activeEdges[edgeId] !== token) return;
      const next = { ...get().activeEdges };
      delete next[edgeId];
      set({ activeEdges: next });
    }, FLASH_MS);
  },
}));

/**
 * Listens for `skill://message` and flashes the edge the message travelled.
 * Mounted once in Canvas.
 */
export function useSkillMessages() {
  useEffect(() => {
    const unlisten = listen<SkillMessagePayload>("skill://message", (event) => {
      const { fromNodeId, toNodeId } = event.payload;
      const edge = useWorkspace
        .getState()
        .edges.find(
          (e) =>
            (e.source === fromNodeId && e.target === toNodeId) ||
            (e.source === toNodeId && e.target === fromNodeId),
        );
      if (edge) useSkillActivity.getState().flash(edge.id);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
}
