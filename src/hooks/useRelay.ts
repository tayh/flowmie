import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspace } from "./useWorkspace";
import { trimResponse } from "../lib/sanitize";
import type { PtyDataEvent } from "../types/pty";
import type { FlowmieEdge, TerminalRFNode } from "../types/workspace";
import { skillsDefault } from "../types/workspace";

// A skill-enabled agent communicates through the explicit send_message channel
// (F002), so its full-screen TUI output must NOT be scraped and forwarded — that
// scraping is what leaked terminal furniture (spinners, status bars, input-box
// text) into a peer's input. The passive relay stays only for non-skill sources
// (e.g. a plain shell, whose line output is meaningfully forwardable).
function isSkillEnabled(node: TerminalRFNode): boolean {
  return node.data.skillsEnabled ?? skillsDefault(node.data.agentType);
}

// How long a source terminal must stay quiet before we treat its buffered
// output as a finished response and relay it. The spec's acceptance
// criterion is explicitly "after the agent finishes its response", and
// idle-detection is the "simple trimming heuristic" it sanctions.
//
// This has to be long enough to sit through an interactive agent's natural
// pauses (streaming a reply, "thinking") — at 800ms it fired between slow
// keystrokes and mid-stream, dumping fragments. A couple of seconds of true
// silence is a much better "the agent is done" signal.
const IDLE_MS = 2500;

/**
 * Orchestrates terminal-to-terminal relays entirely on the frontend, which
 * already receives every terminal's `pty://data` stream. Buffers each
 * source terminal's output, and once it goes idle, sanitizes the buffer and
 * writes it to the input of every terminal it's connected to via an enabled
 * edge. Mounted once (in Canvas).
 *
 * Note: a deliberately-created cycle (A→B and B→A) will feed back on itself;
 * the per-edge enable/disable toggle is the intended escape hatch for that.
 */
export function useRelay() {
  const buffersRef = useRef<Map<string, string>>(new Map());
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const buffers = buffersRef.current;
    const timers = timersRef.current;

    function terminalByPtyId(ptyId: string): TerminalRFNode | undefined {
      return useWorkspace
        .getState()
        .nodes.find(
          (n): n is TerminalRFNode => n.type === "terminal" && n.data.ptyId === ptyId,
        );
    }

    // Edges for which `nodeId` is a relay *source* (respecting direction).
    function outgoingEdges(nodeId: string): FlowmieEdge[] {
      return useWorkspace.getState().edges.filter((e) => {
        if (!e.data?.enabled) return false;
        if (e.source === nodeId) return true;
        return e.data.direction === "bidirectional" && e.target === nodeId;
      });
    }

    function flush(sourceNodeId: string) {
      const raw = buffers.get(sourceNodeId) ?? "";
      buffers.delete(sourceNodeId);
      timers.delete(sourceNodeId);

      const nodes = useWorkspace.getState().nodes;
      const sourceNode = nodes.find(
        (n): n is TerminalRFNode => n.id === sourceNodeId && n.type === "terminal",
      );
      if (!sourceNode) return;

      const message = trimResponse(raw, sourceNode.data.agentType);
      if (!message) return;

      const updateNoteContent = useWorkspace.getState().updateNoteContent;

      for (const edge of outgoingEdges(sourceNodeId)) {
        const targetNodeId = edge.source === sourceNodeId ? edge.target : edge.source;
        const targetNode = nodes.find((n) => n.id === targetNodeId);
        if (!targetNode) continue;

        if (targetNode.type === "terminal") {
          if (!targetNode.data.ptyId) continue;
          // Deliver via the agent-aware submit path: TUI agents get the text
          // as bracketed paste (nothing dropped) followed by a submit.
          void invoke("pty_submit", {
            ptyId: targetNode.data.ptyId,
            text: message,
            agentType: targetNode.data.agentType,
          });
        } else if (targetNode.type === "note") {
          // Append the response to the note rather than feeding it as input.
          const existing = targetNode.data.content;
          const separator = existing.trim() === "" ? "" : "\n\n";
          updateNoteContent(targetNode.id, `${existing}${separator}${message}`);
        }
      }
    }

    const unlistenPromise = listen<PtyDataEvent>("pty://data", (event) => {
      const sourceNode = terminalByPtyId(event.payload.ptyId);
      if (!sourceNode) return;
      // Skill-enabled agents talk via send_message, not by having their screen
      // scraped — never buffer/forward their raw output.
      if (isSkillEnabled(sourceNode)) return;
      // Only buffer terminals that actually feed an enabled relay.
      if (outgoingEdges(sourceNode.id).length === 0) return;

      buffers.set(sourceNode.id, (buffers.get(sourceNode.id) ?? "") + event.payload.data);

      const existing = timers.get(sourceNode.id);
      if (existing !== undefined) window.clearTimeout(existing);
      timers.set(
        sourceNode.id,
        window.setTimeout(() => flush(sourceNode.id), IDLE_MS),
      );
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      buffers.clear();
    };
  }, []);
}
