import { useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "../../hooks/usePty";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { TerminalRFNode } from "../../types/workspace";
import { skillsDefault } from "../../types/workspace";
import { ResourceTray, useResourceDropTarget } from "./ResourceTray";
import "./TerminalNode.css";

export function TerminalNode({ id, data }: NodeProps<TerminalRFNode>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const removeNode = useWorkspace((s) => s.removeNode);
  const respawnNode = useWorkspace((s) => s.respawnNode);
  const toggleSkills = useWorkspace((s) => s.toggleSkills);
  const dropTarget = useResourceDropTarget(id);

  // The Skills switch is meaningful only for agents — a shell has no MCP config
  // to strip. It only wires in at spawn, so flipping it queues the change for
  // the next respawn rather than touching the running process.
  const isAgent = data.agentType !== "shell";
  const skillsEnabled = data.skillsEnabled ?? skillsDefault(data.agentType);
  const running = data.ptyId !== null;

  const { status, exitCode, errorMessage, write, resize } = usePty(data.ptyId, (chunk) =>
    terminalRef.current?.write(chunk),
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#1e1e1e" },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    if (data.ptyId === null) {
      terminal.write("\x1b[90mdisconnected — click ⟲ to respawn\x1b[0m\r\n");
    }

    terminalRef.current = terminal;

    const dataDisposable = terminal.onData((chunk) => write(chunk));
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      resize(terminal.cols, terminal.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
    // Set up xterm once per node instance; write/resize track the latest
    // ptyId internally via usePty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status === "exited" && terminalRef.current) {
      terminalRef.current.write(
        `\r\n\x1b[31mprocess exited (code ${exitCode ?? "unknown"})\x1b[0m\r\n`,
      );
    }
    if (status === "error" && terminalRef.current) {
      terminalRef.current.write(`\r\n\x1b[31merror: ${errorMessage}\x1b[0m\r\n`);
    }
  }, [status, exitCode, errorMessage]);

  return (
    <div className="terminal-node" onDragOver={dropTarget.onDragOver} onDrop={dropTarget.onDrop}>
      <Handle type="target" position={Position.Left} />
      <div className="terminal-node__titlebar">
        <span className="terminal-node__label">{data.agentType}</span>
        <div className="terminal-node__actions">
          {isAgent && (
            <button
              type="button"
              className={`terminal-node__skills${skillsEnabled ? "" : " terminal-node__skills--off"}`}
              onClick={() => toggleSkills(id)}
              title={
                (skillsEnabled
                  ? "Skills on — this agent gets Flowmie's canvas tools."
                  : "Skills off — no MCP tools are wired in.") +
                (running ? " Applies on next respawn (⟲)." : "")
              }
            >
              skills {skillsEnabled ? "on" : "off"}
            </button>
          )}
          {data.ptyId === null && (
            <button type="button" onClick={() => respawnNode(id)} title="Respawn">
              ⟲
            </button>
          )}
          <button type="button" onClick={() => removeNode(id)} title="Close">
            ×
          </button>
        </div>
      </div>
      <div className="terminal-node__body nodrag nopan nowheel" ref={containerRef} />
      <ResourceTray nodeId={id} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
