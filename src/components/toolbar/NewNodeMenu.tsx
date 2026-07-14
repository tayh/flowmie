import { useState } from "react";
import type { AgentType } from "../../types/pty";
import "./NewNodeMenu.css";

const AGENTS: { value: AgentType; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "shell", label: "Shell" },
];

interface NewNodeMenuProps {
  onSelect: (agentType: AgentType) => void;
}

export function NewNodeMenu({ onSelect }: NewNodeMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="new-node-menu">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        + New terminal
      </button>
      {open && (
        <ul className="new-node-menu__list">
          {AGENTS.map((agent) => (
            <li key={agent.value}>
              <button
                type="button"
                onClick={() => {
                  onSelect(agent.value);
                  setOpen(false);
                }}
              >
                {agent.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
