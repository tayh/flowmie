export type AgentType = "claude" | "codex" | "opencode" | "shell";

export interface PtySpawnResult {
  ptyId: string;
}

export interface PtyDataEvent {
  ptyId: string;
  data: string;
}

export interface PtyExitEvent {
  ptyId: string;
  exitCode: number;
}

export interface PtyErrorEvent {
  ptyId: string;
  message: string;
}
