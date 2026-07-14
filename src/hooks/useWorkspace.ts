import { create } from "zustand";
import { applyNodeChanges, type NodeChange, type OnNodesChange } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentType } from "../types/pty";
import type {
  TerminalNodeData,
  TerminalRFNode,
  Viewport,
  Workspace,
  WorkspaceSummary,
} from "../types/workspace";

const DEFAULT_SIZE = { width: 480, height: 320 };

function newId(): string {
  return crypto.randomUUID();
}

function toCanvasNode(node: TerminalRFNode): TerminalNodeData {
  return {
    id: node.id,
    type: "terminal",
    position: node.position,
    size: {
      width: typeof node.width === "number" ? node.width : DEFAULT_SIZE.width,
      height: typeof node.height === "number" ? node.height : DEFAULT_SIZE.height,
    },
    agentType: node.data.agentType,
    role: node.data.role,
    cwd: node.data.cwd,
    ptyId: null,
  };
}

function fromCanvasNode(canvasNode: TerminalNodeData): TerminalRFNode {
  return {
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
}

interface WorkspaceState {
  workspaceId: string;
  name: string;
  createdAt: string;
  nodes: TerminalRFNode[];
  viewport: Viewport;
  onNodesChange: OnNodesChange<TerminalRFNode>;
  setViewport: (viewport: Viewport) => void;
  addTerminal: (agentType: AgentType, cwd?: string, position?: { x: number; y: number }) => Promise<void>;
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

  onNodesChange: (changes: NodeChange<TerminalRFNode>[]) => {
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
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
      data: { agentType, cwd, ptyId },
    };
    set({ nodes: [...get().nodes, node] });
  },

  removeNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (node?.data.ptyId) {
      await invoke("pty_kill", { ptyId: node.data.ptyId });
    }
    set({ nodes: get().nodes.filter((n) => n.id !== nodeId) });
  },

  respawnNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const { ptyId } = await invoke<{ ptyId: string }>("pty_spawn", {
      agentType: node.data.agentType,
      cwd: node.data.cwd,
      role: node.data.role,
    });
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ptyId } } : n,
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
