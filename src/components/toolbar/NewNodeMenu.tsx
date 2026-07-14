import { useState } from "react";
import type { AgentType } from "../../types/pty";
import "./NewNodeMenu.css";

const AGENTS: { value: AgentType; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "shell", label: "Shell" },
];

const WEB_PRESETS: { url: string; label: string }[] = [
  { url: "https://chat.openai.com", label: "ChatGPT" },
  { url: "https://gemini.google.com", label: "Gemini" },
];

interface NewNodeMenuProps {
  onSelectAgent: (agentType: AgentType) => void;
  onSelectWeb: (url: string, label: string) => void;
}

export function NewNodeMenu({ onSelectAgent, onSelectWeb }: NewNodeMenuProps) {
  const [open, setOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);

  function close() {
    setOpen(false);
    setWebOpen(false);
  }

  function handleCustomUrl() {
    const url = window.prompt("URL");
    if (!url) return;
    let label = url;
    try {
      label = new URL(url).hostname;
    } catch {
      // keep raw url as the label if it doesn't parse
    }
    onSelectWeb(url, label);
    close();
  }

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
                  onSelectAgent(agent.value);
                  close();
                }}
              >
                {agent.label}
              </button>
            </li>
          ))}
          <li className="new-node-menu__separator" />
          <li
            className="new-node-menu__submenu"
            onMouseEnter={() => setWebOpen(true)}
            onMouseLeave={() => setWebOpen(false)}
          >
            <button type="button">Web ▸</button>
            {webOpen && (
              <ul className="new-node-menu__list new-node-menu__list--flyout">
                {WEB_PRESETS.map((preset) => (
                  <li key={preset.url}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectWeb(preset.url, preset.label);
                        close();
                      }}
                    >
                      {preset.label}
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" onClick={handleCustomUrl}>
                    Custom URL…
                  </button>
                </li>
              </ul>
            )}
          </li>
        </ul>
      )}
    </div>
  );
}
