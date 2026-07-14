import type { AgentType } from "../types/pty";

// Matches the ANSI escape families a terminal agent emits: CSI sequences
// (colors, cursor moves, erase), OSC sequences (window title, hyperlinks,
// terminated by BEL or ST), and standalone single-character escapes.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const SINGLE_ESC_RE = /\x1b[@-Z\\-_]/g;
// Remaining C0 control chars except \n and \t, which we keep as real text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strips ANSI escape sequences and stray control characters from PTY output. */
export function stripAnsi(input: string): string {
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(SINGLE_ESC_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "");
}

/**
 * Heuristically decides whether a line is a shell prompt (and therefore not
 * part of the command's actual output). Covers the common cases: theme
 * arrow prompts (oh-my-zsh `➜`, starship/pure `❯`, `»`) and classic
 * `user@host:~/path$` / `#` / `%` / `>` prompts. A prompt line that also
 * carries the echoed command (e.g. `➜  ~ echo hi`) is intentionally
 * matched too, so the echoed input is dropped along with it.
 */
function isShellPromptLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  if (/^[➜❯»▶]/.test(t)) return true;
  // Ends in a prompt sigil (optionally with a trailing job/paren marker).
  if (/[$#%>][)\]]?\s*$/.test(t)) return true;
  return false;
}

/**
 * Reduces a buffered, already-idle output chunk to the agent's latest
 * response — a deliberately simple heuristic (per the spec) that strips
 * ANSI, drops blank edges, and for shells removes prompt lines (wherever
 * they appear, since the echoed command rides on the leading prompt line).
 * Real per-CLI tuning can layer on later.
 */
export function trimResponse(text: string, agentType: AgentType): string {
  const clean = stripAnsi(text);
  let lines = clean.split("\n");

  if (agentType === "shell") {
    lines = lines.filter((line) => !isShellPromptLine(line));
  }

  // Drop leading/trailing blank lines.
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

  return lines.join("\n").trim();
}
