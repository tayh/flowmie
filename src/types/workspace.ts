import type { Edge, Node } from "@xyflow/react";
import type { AgentType } from "./pty";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface Position {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

/** Persisted node shapes (mirror src-tauri/src/workspace/mod.rs). */
export interface TerminalNodeData {
  id: string;
  type: "terminal";
  position: Position;
  size: Size;
  agentType: AgentType;
  role?: string;
  cwd: string;
  // Whether this agent is wired to the skills bridge (F002). Defaults to true
  // for agent types and false for shell; see skillsDefault().
  skillsEnabled?: boolean;
  // Runtime-only; always null on disk. Set again after a manual respawn.
  ptyId: string | null;
}

export interface WebviewNodeData {
  id: string;
  type: "webview";
  position: Position;
  size: Size;
  url: string;
  label: string;
}

export interface NoteNodeData {
  id: string;
  type: "note";
  position: Position;
  size: Size;
  content: string;
  connectedTerminalId: string | null;
}

/** A file or folder on the canvas (F003). Unlike a blob resource, this is a
 * *live pointer*: `path` is read from disk at call time, so edits on disk reach
 * a connected agent on its next read. */
export interface FileNodeData {
  id: string;
  type: "file";
  position: Position;
  size: Size;
  // Absolute path to the file or folder this node points at.
  path: string;
  label: string;
  isDirectory: boolean;
}

export type CanvasNode = TerminalNodeData | WebviewNodeData | NoteNodeData | FileNodeData;

export type EdgeDirection = "source-to-target" | "bidirectional";

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  direction: EdgeDirection;
  // Whether the relay is currently active; toggled per-edge for debugging.
  enabled: boolean;
}

export type ResourceKind = "image" | "text" | "file";

/** A canvas resource (F002 Phase 3). Mirrors src-tauri/src/resources/mod.rs.
 * The blob lives on disk at `path`; only this lightweight ref is persisted. */
export interface ResourceRef {
  id: string;
  kind: ResourceKind;
  mime: string;
  label: string;
  ownerNodeId: string | null;
  createdAt: string;
  path: string;
}

/** What `file_stat` reports about a path (F003). Mirrors src-tauri/src/files. */
export interface FileStat {
  exists: boolean;
  isDirectory: boolean;
  size: number;
  mime: string;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  viewport: Viewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  // F002 Phase 3; defaults to [] for pre-Phase-3 workspaces.
  resources: ResourceRef[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  updatedAt: string;
}

/** React Flow node data payloads (position/size live on the RF node itself). */
export interface TerminalNodePayload extends Record<string, unknown> {
  agentType: AgentType;
  role?: string;
  cwd: string;
  skillsEnabled?: boolean;
  ptyId: string | null;
}

/** Skills are on by default for real agents, off for a plain shell. */
export function skillsDefault(agentType: AgentType): boolean {
  return agentType !== "shell";
}

export interface WebviewNodePayload extends Record<string, unknown> {
  url: string;
  label: string;
  // Runtime-only; always null on disk. Set again after a manual respawn.
  webviewLabel: string | null;
}

export interface NoteNodePayload extends Record<string, unknown> {
  content: string;
  connectedTerminalId: string | null;
}

export interface FileNodePayload extends Record<string, unknown> {
  path: string;
  label: string;
  isDirectory: boolean;
  // Runtime-only: whether the path was present at the last check. Not persisted
  // — a file can appear or vanish between sessions, so it is re-checked on load.
  missing: boolean;
}

export type TerminalRFNode = Node<TerminalNodePayload, "terminal">;
export type WebviewRFNode = Node<WebviewNodePayload, "webview">;
export type NoteRFNode = Node<NoteNodePayload, "note">;
export type FileRFNode = Node<FileNodePayload, "file">;
export type FlowmieRFNode = TerminalRFNode | WebviewRFNode | NoteRFNode | FileRFNode;

/** React Flow edge data payload. */
export interface RelayEdgePayload extends Record<string, unknown> {
  direction: EdgeDirection;
  enabled: boolean;
}

export type FlowmieEdge = Edge<RelayEdgePayload, "relay">;
