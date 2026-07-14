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

// Preset roles spawn a Claude Code terminal seeded with an initial
// instruction (injected on spawn via pty_write).
const ROLE_PRESETS: { label: string; instruction: string }[] = [
  {
    label: "Bug Whisperer",
    instruction:
      "You are the Bug Whisperer: a debugging specialist. When given a problem, reproduce it, isolate the root cause, and propose the smallest correct fix. Explain your reasoning concisely.",
  },
  {
    label: "Code Reviewer",
    instruction:
      "You are a meticulous code reviewer. Review changes for correctness, edge cases, and simplicity. Point out concrete issues with file/line references and suggest improvements.",
  },
  {
    label: "Test Writer",
    instruction:
      "You are a testing specialist. Write focused, meaningful tests that cover the important behavior and edge cases of the code you are given.",
  },
];

interface NewNodeMenuProps {
  onSelectAgent: (agentType: AgentType) => void;
  onSelectWeb: (url: string, label: string) => void;
  onSelectRole: (instruction: string) => void;
  onAddNote: () => void;
}

export function NewNodeMenu({
  onSelectAgent,
  onSelectWeb,
  onSelectRole,
  onAddNote,
}: NewNodeMenuProps) {
  const [open, setOpen] = useState(false);
  const [flyout, setFlyout] = useState<"web" | "roles" | null>(null);

  function close() {
    setOpen(false);
    setFlyout(null);
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
        + New
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
            onMouseEnter={() => setFlyout("roles")}
            onMouseLeave={() => setFlyout(null)}
          >
            <button type="button">Roles ▸</button>
            {flyout === "roles" && (
              <ul className="new-node-menu__list new-node-menu__list--flyout">
                {ROLE_PRESETS.map((role) => (
                  <li key={role.label}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectRole(role.instruction);
                        close();
                      }}
                    >
                      {role.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>

          <li
            className="new-node-menu__submenu"
            onMouseEnter={() => setFlyout("web")}
            onMouseLeave={() => setFlyout(null)}
          >
            <button type="button">Web ▸</button>
            {flyout === "web" && (
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

          <li className="new-node-menu__separator" />

          <li>
            <button
              type="button"
              onClick={() => {
                onAddNote();
                close();
              }}
            >
              Note
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
