import type { AgentType } from "../types/pty";

// Matches the ANSI escape families a terminal agent emits:
// - CSI: colors, cursor moves, erase — ESC [ params intermediates final
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// - OSC: window title, hyperlinks — ESC ] ... terminated by BEL or ST
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// - nF sequences: ESC + one-or-more intermediate bytes (0x20-0x2F) + final
//   byte (0x30-0x7E). Covers charset designation like `ESC ( B` / `ESC ) 0`,
//   which otherwise leak their tail (`(B`, `)0`) once the ESC byte alone is
//   stripped as a control char.
// eslint-disable-next-line no-control-regex
const NF_RE = /\x1b[ -/]+[0-~]/g;
// - Standalone Fe/Fs single-char escapes (ESC + one byte 0x40-0x5F or 0x60-0x7E).
// eslint-disable-next-line no-control-regex
const SINGLE_ESC_RE = /\x1b[@-~]/g;
// Remaining C0 control chars except \n and \t, which we keep as real text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strips ANSI escape sequences and stray control characters from PTY output. */
export function stripAnsi(input: string): string {
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(NF_RE, "")
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
