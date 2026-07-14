import { create } from "zustand";
import { applyNodeChanges, type NodeChange, type OnNodesChange } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentType } from "../types/pty";
import type {
  CanvasNode,
  FlowmieRFNode,
  TerminalNodeData,
  TerminalRFNode,
  Viewport,
  WebviewNodeData,
  WebviewRFNode,
  Workspace,
  WorkspaceSummary,
} from "../types/workspace";
import { flowNodeToWindowBounds, webviewContentArea } from "../lib/webviewBounds";

const DEFAULT_TERMINAL_SIZE = { width: 480, height: 320 };
const DEFAULT_WEBVIEW_SIZE = { width: 640, height: 520 };

function newId(): string {
  return crypto.randomUUID();
}

function getContainerOffset(): { left: number; top: number } {
  const el = document.querySelector(".canvas");
  if (!el) return { left: 0, top: 0 };
  const rect = el.getBoundingClientRect();
  return { left: rect.left, top: rect.top };
}

function nodeSize(node: FlowmieRFNode, fallback: { width: number; height: number }) {
  return {
    width: typeof node.width === "number" ? node.width : fallback.width,
    height: typeof node.height === "number" ? node.height : fallback.height,
  };
}

function toCanvasNode(node: FlowmieRFNode): CanvasNode {
  if (node.type === "webview") {
    const data: WebviewNodeData = {
      id: node.id,
      type: "webview",
      position: node.position,
      size: nodeSize(node, DEFAULT_WEBVIEW_SIZE),
      url: node.data.url,
      label: node.data.label,
    };
    return data;
  }
  const data: TerminalNodeData = {
    id: node.id,
    type: "terminal",
    position: node.position,
    size: nodeSize(node, DEFAULT_TERMINAL_SIZE),
    agentType: node.data.agentType,
    role: node.data.role,
    cwd: node.data.cwd,
    ptyId: null,
  };
  return data;
}

function fromCanvasNode(canvasNode: CanvasNode): FlowmieRFNode {
  if (canvasNode.type === "webview") {
    const node: WebviewRFNode = {
      id: canvasNode.id,
      type: "webview",
      position: canvasNode.position,
      width: canvasNode.size.width,
      height: canvasNode.size.height,
      data: { url: canvasNode.url, label: canvasNode.label, webviewLabel: null },
    };
    return node;
  }
  const node: TerminalRFNode = {
    id: canvasNode.id,
    type: "terminal",
    position: canvasNode.position,
    width: canvasNode.size.width,
    height: canvasNode.size.height,
    data: {
      agentType: canvasNode.agentType,
      role: canvasNode.role,
      cwd: canvasNode.cwd,
      ptyId: null,
    },
  };
  return node;
}

interface WorkspaceState {
  workspaceId: string;
  name: string;
  createdAt: string;
  nodes: FlowmieRFNode[];
  viewport: Viewport;
  onNodesChange: OnNodesChange<FlowmieRFNode>;
  setViewport: (viewport: Viewport) => void;
  addTerminal: (agentType: AgentType, cwd?: string, position?: { x: number; y: number }) => Promise<void>;
  addWebview: (url: string, label: string, position?: { x: number; y: number }) => Promise<void>;
  removeNode: (nodeId: string) => Promise<void>;
  respawnNode: (nodeId: string) => Promise<void>;
  saveWorkspace: () => Promise<void>;
  loadWorkspace: (workspaceId: string) => Promise<void>;
  listWorkspaces: () => Promise<WorkspaceSummary[]>;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaceId: newId(),
  name: "Untitled Workspace",
  createdAt: new Date().toISOString(),
  nodes: [],
  viewport: { x: 0, y: 0, zoom: 1 },

  onNodesChange: (changes: NodeChange<FlowmieRFNode>[]) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  setViewport: (viewport) => set({ viewport }),

  addTerminal: async (agentType, cwd = "", position) => {
    const id = newId();
    const index = get().nodes.length;
    const spawnPosition = position ?? { x: 80 + index * 40, y: 80 + index * 40 };
    const { ptyId } = await invoke<{ ptyId: string }>("pty_spawn", {
      agentType,
      cwd,
      role: undefined,
    });
    const node: TerminalRFNode = {
      id,
      type: "terminal",
      position: spawnPosition,
      width: DEFAULT_TERMINAL_SIZE.width,
      height: DEFAULT_TERMINAL_SIZE.height,
      data: { agentType, cwd, ptyId },
    };
    set({ nodes: [...get().nodes, node] });
  },

  addWebview: async (url, label, position) => {
    const id = newId();
    const index = get().nodes.length;
    const spawnPosition = position ?? { x: 80 + index * 40, y: 80 + index * 40 };
    const contentArea = webviewContentArea(spawnPosition, DEFAULT_WEBVIEW_SIZE);
    const bounds = flowNodeToWindowBounds(
      contentArea.position,
      contentArea.size,
      get().viewport,
      getContainerOffset(),
    );
    const { webviewLabel } = await invoke<{ webviewLabel: string }>("webview_create", {
      nodeId: id,
      url,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    const node: WebviewRFNode = {
      id,
      type: "webview",
      position: spawnPosition,
      width: DEFAULT_WEBVIEW_SIZE.width,
      height: DEFAULT_WEBVIEW_SIZE.height,
      data: { url, label, webviewLabel },
    };
    set({ nodes: [...get().nodes, node] });
  },

  removeNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (node?.type === "terminal" && node.data.ptyId) {
      await invoke("pty_kill", { ptyId: node.data.ptyId });
    }
    if (node?.type === "webview" && node.data.webviewLabel) {
      await invoke("webview_destroy", { webviewLabel: node.data.webviewLabel });
    }
    set({ nodes: get().nodes.filter((n) => n.id !== nodeId) });
  },

  respawnNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    if (node.type === "terminal") {
      const { ptyId } = await invoke<{ ptyId: string }>("pty_spawn", {
        agentType: node.data.agentType,
        cwd: node.data.cwd,
        role: node.data.role,
      });
      set({
        nodes: get().nodes.map((n) =>
          n.id === nodeId && n.type === "terminal" ? { ...n, data: { ...n.data, ptyId } } : n,
        ),
      });
      return;
    }

    const contentArea = webviewContentArea(node.position, nodeSize(node, DEFAULT_WEBVIEW_SIZE));
    const bounds = flowNodeToWindowBounds(
      contentArea.position,
      contentArea.size,
      get().viewport,
      getContainerOffset(),
    );
    const { webviewLabel } = await invoke<{ webviewLabel: string }>("webview_create", {
      nodeId: node.id,
      url: node.data.url,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId && n.type === "webview" ? { ...n, data: { ...n.data, webviewLabel } } : n,
      ),
    });
  },

  saveWorkspace: async () => {
    const state = get();
    const workspace: Workspace = {
      id: state.workspaceId,
      name: state.name,
      createdAt: state.createdAt,
      updatedAt: new Date().toISOString(),
      viewport: state.viewport,
      nodes: state.nodes.map(toCanvasNode),
      edges: [],
    };
    await invoke("workspace_save", { workspace });
  },

  loadWorkspace: async (workspaceId) => {
    const workspace = await invoke<Workspace>("workspace_load", { workspaceId });
    set({
      workspaceId: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt,
      viewport: workspace.viewport,
      nodes: workspace.nodes.map(fromCanvasNode),
    });
  },

  listWorkspaces: async () => invoke<WorkspaceSummary[]>("workspace_list"),
}));
