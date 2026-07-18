import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspace } from "./useWorkspace";
import type { FlowmieEdge, FlowmieRFNode } from "../types/workspace";

/**
 * Pushes a compact copy of the canvas topology to the backend skills bridge
 * (F002) whenever nodes or edges change, so an agent's skill calls
 * (`list_agents`, `get_connections`, …) always see the live graph. Mounted
 * once in Canvas.
 *
 * Only terminals and edges matter to the bridge; positions/sizes are omitted.
 * Debounced lightly — agents poll on demand, not per frame, but drags emit a
 * burst of node changes we don't need to forward individually.
 */
export function buildSnapshot(nodes: FlowmieRFNode[], edges: FlowmieEdge[]) {
  const terminals = nodes
    .filter((n): n is Extract<FlowmieRFNode, { type: "terminal" }> => n.type === "terminal")
    .map((n) => ({
      id: n.id,
      agentType: n.data.agentType,
      role: n.data.role,
      cwd: n.data.cwd,
      ptyId: n.data.ptyId,
    }));
  const bridgeEdges = edges.map((e) => ({
    source: e.source,
    target: e.target,
    direction: e.data?.direction ?? "source-to-target",
    enabled: e.data?.enabled ?? true,
  }));
  // Webviews (for capture_webview to resolve a Portal) and notes (surfaced as
  // text resources) also matter to the resource skills (F002 Phase 3).
  const webviews = nodes
    .filter((n): n is Extract<FlowmieRFNode, { type: "webview" }> => n.type === "webview")
    .map((n) => ({ id: n.id, webviewLabel: n.data.webviewLabel, label: n.data.label }));
  const notes = nodes
    .filter((n): n is Extract<FlowmieRFNode, { type: "note" }> => n.type === "note")
    .map((n) => ({
      id: n.id,
      content: n.data.content,
      connectedTerminalId: n.data.connectedTerminalId,
    }));
  // File nodes (F003) carry a live path the bridge reads on demand; an agent
  // sees one only when an enabled edge connects it, so the edges above are what
  // actually grant access.
  const files = nodes
    .filter((n): n is Extract<FlowmieRFNode, { type: "file" }> => n.type === "file")
    .map((n) => ({
      id: n.id,
      path: n.data.path,
      label: n.data.label,
      isDirectory: n.data.isDirectory,
      ignore: n.data.ignore ?? [],
    }));
  return { terminals, edges: bridgeEdges, webviews, notes, files };
}

export function useSkillsSync() {
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    function push() {
      const { nodes, edges } = useWorkspace.getState();
      void invoke("skills_sync_topology", {
        snapshot: buildSnapshot(nodes, edges),
      });
    }

    // Initial push so a freshly loaded workspace is visible to agents.
    push();

    const unsubscribe = useWorkspace.subscribe((state, prev) => {
      if (state.nodes === prev.nodes && state.edges === prev.edges) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(push, 200);
    });

    return () => {
      unsubscribe();
      window.clearTimeout(timerRef.current);
    };
  }, []);
}
