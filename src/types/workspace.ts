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

export type CanvasNode = TerminalNodeData | WebviewNodeData | NoteNodeData;

export type EdgeDirection = "source-to-target" | "bidirectional";

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  direction: EdgeDirection;
  // Whether the relay is currently active; toggled per-edge for debugging.
  enabled: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  viewport: Viewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
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
  ptyId: string | null;
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

export type TerminalRFNode = Node<TerminalNodePayload, "terminal">;
export type WebviewRFNode = Node<WebviewNodePayload, "webview">;
export type NoteRFNode = Node<NoteNodePayload, "note">;
export type FlowmieRFNode = TerminalRFNode | WebviewRFNode | NoteRFNode;

/** React Flow edge data payload. */
export interface RelayEdgePayload extends Record<string, unknown> {
  direction: EdgeDirection;
  enabled: boolean;
}

export type FlowmieEdge = Edge<RelayEdgePayload, "relay">;
