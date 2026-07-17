import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentType } from "../types/pty";
import type {
  CanvasEdge,
  CanvasNode,
  FlowmieEdge,
  FlowmieRFNode,
  NoteNodeData,
  NoteRFNode,
  ResourceKind,
  ResourceRef,
  TerminalNodeData,
  TerminalRFNode,
  Viewport,
  WebviewNodeData,
  WebviewRFNode,
  Workspace,
  WorkspaceSummary,
} from "../types/workspace";
import { skillsDefault } from "../types/workspace";
import { flowNodeToWindowBounds, webviewContentArea } from "../lib/webviewBounds";

const DEFAULT_TERMINAL_SIZE = { width: 480, height: 320 };
const DEFAULT_WEBVIEW_SIZE = { width: 640, height: 520 };
const DEFAULT_NOTE_SIZE = { width: 300, height: 220 };

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
  if (node.type === "note") {
    const data: NoteNodeData = {
      id: node.id,
      type: "note",
      position: node.position,
      size: nodeSize(node, DEFAULT_NOTE_SIZE),
      content: node.data.content,
      connectedTerminalId: node.data.connectedTerminalId,
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
    skillsEnabled: node.data.skillsEnabled ?? skillsDefault(node.data.agentType),
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
  if (canvasNode.type === "note") {
    const node: NoteRFNode = {
      id: canvasNode.id,
      type: "note",
      position: canvasNode.position,
      width: canvasNode.size.width,
      height: canvasNode.size.height,
      data: {
        content: canvasNode.content,
        connectedTerminalId: canvasNode.connectedTerminalId,
      },
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
      skillsEnabled: canvasNode.skillsEnabled ?? skillsDefault(canvasNode.agentType),
      ptyId: null,
    },
  };
  return node;
}

function toCanvasEdge(edge: FlowmieEdge): CanvasEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    direction: edge.data?.direction ?? "source-to-target",
    enabled: edge.data?.enabled ?? true,
  };
}

function fromCanvasEdge(canvasEdge: CanvasEdge): FlowmieEdge {
  return {
    id: canvasEdge.id,
    type: "relay",
    source: canvasEdge.source,
    target: canvasEdge.target,
    data: { direction: canvasEdge.direction, enabled: canvasEdge.enabled },
  };
}

interface WorkspaceState {
  workspaceId: string;
  name: string;
  createdAt: string;
  nodes: FlowmieRFNode[];
  edges: FlowmieEdge[];
  viewport: Viewport;
  resources: ResourceRef[];
  onNodesChange: OnNodesChange<FlowmieRFNode>;
  onEdgesChange: OnEdgesChange<FlowmieEdge>;
  onConnect: (connection: Connection) => void;
  toggleEdge: (edgeId: string) => void;
  toggleEdgeDirection: (edgeId: string) => void;
  setViewport: (viewport: Viewport) => void;
  // F002 Phase 3 resources.
  addResource: (resource: ResourceRef) => void;
  removeResource: (resourceId: string) => void;
  registerResource: (input: {
    kind: ResourceKind;
    mime: string;
    label: string;
    ownerNodeId?: string | null;
    dataBase64?: string;
    srcPath?: string;
  }) => Promise<ResourceRef>;
  captureWebview: (nodeId: string) => Promise<void>;
  reshareResource: (resourceId: string, toNodeId: string) => Promise<void>;
  addTerminal: (
    agentType: AgentType,
    opts?: { cwd?: string; role?: string; position?: { x: number; y: number } },
  ) => Promise<void>;
  addWebview: (url: string, label: string, position?: { x: number; y: number }) => Promise<void>;
  addNote: (position?: { x: number; y: number }) => void;
  updateNoteContent: (nodeId: string, content: string) => void;
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
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  resources: [],

  onNodesChange: (changes: NodeChange<FlowmieRFNode>[]) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes: EdgeChange<FlowmieEdge>[]) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection: Connection) => {
    // Valid wires: terminal→terminal (relay input), terminal→note (append
    // output), and terminal↔webview (F002 Phase 3 — lets an agent connect to a
    // Portal so it can capture it). At least one end must be a terminal.
    const nodes = get().nodes;
    const source = nodes.find((n) => n.id === connection.source);
    const target = nodes.find((n) => n.id === connection.target);
    if (connection.source === connection.target) return;
    const isTerminal = (n: FlowmieRFNode | undefined) => n?.type === "terminal";
    const valid =
      (isTerminal(source) &&
        (isTerminal(target) || target?.type === "note" || target?.type === "webview")) ||
      (source?.type === "webview" && isTerminal(target));
    if (!source || !target || !valid) return;

    const edge: FlowmieEdge = {
      id: newId(),
      type: "relay",
      source: connection.source,
      target: connection.target,
      data: { direction: "source-to-target", enabled: true },
    };
    set({
      edges: addEdge(edge, get().edges),
      // Record the connection on the note so it round-trips in the model.
      nodes:
        target.type === "note"
          ? nodes.map((n) =>
              n.id === target.id && n.type === "note"
                ? { ...n, data: { ...n.data, connectedTerminalId: source.id } }
                : n,
            )
          : nodes,
    });
  },

  toggleEdge: (edgeId: string) => {
    set({
      edges: get().edges.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...e.data!, enabled: !e.data!.enabled } }
          : e,
      ),
    });
  },

  // Flip a relay between one-way (source→target) and two-way. Two-way is what
  // lets a messaged agent's reply flow back (and wait_for_reply resolve).
  toggleEdgeDirection: (edgeId: string) => {
    set({
      edges: get().edges.map((e) =>
        e.id === edgeId
          ? {
              ...e,
              data: {
                ...e.data!,
                direction:
                  e.data!.direction === "bidirectional"
                    ? "source-to-target"
                    : "bidirectional",
              },
            }
          : e,
      ),
    });
  },

  setViewport: (viewport) => set({ viewport }),

  // Add a resource to the workspace, deduped by id. Shared by the register/
  // capture actions and the `resource://created` listener (agent-side shares
  // arrive only as events), so overlapping adds collapse to one.
  addResource: (resource) => {
    if (get().resources.some((r) => r.id === resource.id)) return;
    set({ resources: [...get().resources, resource] });
  },

  removeResource: (resourceId) => {
    set({ resources: get().resources.filter((r) => r.id !== resourceId) });
  },

  registerResource: async (input) => {
    const resource = await invoke<ResourceRef>("resource_register", {
      kind: input.kind,
      mime: input.mime,
      label: input.label,
      ownerNodeId: input.ownerNodeId ?? null,
      dataBase64: input.dataBase64,
      srcPath: input.srcPath,
    });
    get().addResource(resource);
    return resource;
  },

  captureWebview: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (node?.type !== "webview" || !node.data.webviewLabel) return;
    const resource = await invoke<ResourceRef>("webview_capture", {
      nodeId,
      webviewLabel: node.data.webviewLabel,
      label: `screenshot of ${node.data.label}`,
    });
    get().addResource(resource);
  },

  // Re-publish an existing blob under a new owner so that node's agent can
  // fetch it — the backing content-addressed blob is reused, only a fresh ref
  // is minted. Backs the drag-a-chip-onto-a-node gesture.
  reshareResource: async (resourceId, toNodeId) => {
    const existing = get().resources.find((r) => r.id === resourceId);
    if (!existing || existing.ownerNodeId === toNodeId) return;
    await get().registerResource({
      kind: existing.kind,
      mime: existing.mime,
      label: existing.label,
      ownerNodeId: toNodeId,
      srcPath: existing.path,
    });
  },

  addTerminal: async (agentType, opts = {}) => {
    const { cwd = "", role, position } = opts;
    const id = newId();
    const skillsEnabled = skillsDefault(agentType);
    const index = get().nodes.length;
    const spawnPosition = position ?? { x: 80 + index * 40, y: 80 + index * 40 };
    const { ptyId } = await invoke<{ ptyId: string }>("pty_spawn", {
      agentType,
      cwd,
      role,
      nodeId: id,
      skillsEnabled,
    });
    const node: TerminalRFNode = {
      id,
      type: "terminal",
      position: spawnPosition,
      width: DEFAULT_TERMINAL_SIZE.width,
      height: DEFAULT_TERMINAL_SIZE.height,
      data: { agentType, cwd, role, skillsEnabled, ptyId },
    };
    set({ nodes: [...get().nodes, node] });
  },

  addNote: (position) => {
    const id = newId();
    const index = get().nodes.length;
    const notePosition = position ?? { x: 80 + index * 40, y: 80 + index * 40 };
    const node: NoteRFNode = {
      id,
      type: "note",
      position: notePosition,
      width: DEFAULT_NOTE_SIZE.width,
      height: DEFAULT_NOTE_SIZE.height,
      data: { content: "", connectedTerminalId: null },
    };
    set({ nodes: [...get().nodes, node] });
  },

  updateNoteContent: (nodeId, content) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId && n.type === "note" ? { ...n, data: { ...n.data, content } } : n,
      ),
    });
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
    set({
      nodes: get().nodes.filter((n) => n.id !== nodeId),
      // Drop any relay edges dangling from the removed node.
      edges: get().edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    });
  },

  respawnNode: async (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    if (node.type === "terminal") {
      const { ptyId } = await invoke<{ ptyId: string }>("pty_spawn", {
        agentType: node.data.agentType,
        cwd: node.data.cwd,
        role: node.data.role,
        nodeId: node.id,
        skillsEnabled: node.data.skillsEnabled ?? skillsDefault(node.data.agentType),
      });
      set({
        nodes: get().nodes.map((n) =>
          n.id === nodeId && n.type === "terminal" ? { ...n, data: { ...n.data, ptyId } } : n,
        ),
      });
      return;
    }

    if (node.type !== "webview") return;

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
      edges: state.edges.map(toCanvasEdge),
      resources: state.resources,
    };
    await invoke("workspace_save", { workspace });
  },

  loadWorkspace: async (workspaceId) => {
    const workspace = await invoke<Workspace>("workspace_load", { workspaceId });
    const containerOffset = getContainerOffset();

    // Tear down whatever's currently running so loading over an existing
    // workspace doesn't orphan PTYs or native webviews.
    for (const node of get().nodes) {
      if (node.type === "terminal" && node.data.ptyId) {
        await invoke("pty_kill", { ptyId: node.data.ptyId });
      }
      if (node.type === "webview" && node.data.webviewLabel) {
        await invoke("webview_destroy", { webviewLabel: node.data.webviewLabel });
      }
    }

    // Bring every node back to life rather than leaving it "disconnected":
    // terminals respawn with their saved role/cwd, webviews reload their URL.
    const nodes = await Promise.all(
      workspace.nodes.map(async (canvasNode): Promise<FlowmieRFNode> => {
        const node = fromCanvasNode(canvasNode);
        if (node.type === "terminal" && canvasNode.type === "terminal") {
          try {
            const { ptyId } = await invoke<{ ptyId: string }>("pty_spawn", {
              agentType: canvasNode.agentType,
              cwd: canvasNode.cwd,
              role: canvasNode.role,
              nodeId: canvasNode.id,
              skillsEnabled: canvasNode.skillsEnabled ?? skillsDefault(canvasNode.agentType),
            });
            node.data = { ...node.data, ptyId };
          } catch {
            // Leave disconnected (respawn button available) if spawn fails.
          }
        }
        if (node.type === "webview" && canvasNode.type === "webview") {
          try {
            const contentArea = webviewContentArea(canvasNode.position, canvasNode.size);
            const bounds = flowNodeToWindowBounds(
              contentArea.position,
              contentArea.size,
              workspace.viewport,
              containerOffset,
            );
            const { webviewLabel } = await invoke<{ webviewLabel: string }>("webview_create", {
              nodeId: canvasNode.id,
              url: canvasNode.url,
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            });
            node.data = { ...node.data, webviewLabel };
          } catch {
            // Leave disconnected if webview creation fails.
          }
        }
        return node;
      }),
    );

    // Re-seed the backend resource store so resources shared last session stay
    // fetchable by agents (blobs are still on disk at their content paths).
    const resources = workspace.resources ?? [];
    if (resources.length > 0) {
      try {
        await invoke("resources_sync", { resources });
      } catch {
        // Non-fatal: resources just won't be agent-fetchable until re-shared.
      }
    }

    set({
      workspaceId: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt,
      viewport: workspace.viewport,
      nodes,
      edges: workspace.edges.map(fromCanvasEdge),
      resources,
    });
  },

  listWorkspaces: async () => invoke<WorkspaceSummary[]>("workspace_list"),
}));
