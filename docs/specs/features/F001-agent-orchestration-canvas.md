# Feature Spec — Agent Orchestration Canvas

| Field | Value |
|---|---|
| ID | F001 |
| Status | in-progress |
| Milestone | MVP |

## 1. Overview

A cross-platform desktop application (macOS, Windows, Linux) that provides an infinite canvas where users can organize:

- **Real terminals**, each running a coding agent (Claude Code, Codex, OpenCode, or a plain shell)
- **Embedded webviews**, displaying web pages (ChatGPT, Gemini, or a custom URL)
- **Notes** (sticky notes), optionally populated by a connected terminal
- **Connections** between terminals, allowing one terminal's output to become another terminal's input

Product reference: Maestri (themaestri.app). Webview implementation reference: Pake (github.com/tw93/Pake).

---

## 2. Technical stack

| Layer | Technology | Rationale |
|---|---|---|
| Desktop framework | Tauri v2 | Lightweight binary, native OS WebView, and a robust Rust backend for PTY support |
| Frontend | React + TypeScript | Mature ecosystem with strong React Flow integration |
| Canvas | React Flow | Pan/zoom, custom nodes, and native edges — avoids reinventing the canvas engine |
| Terminal | xterm.js | Industry standard (used by VS Code) with robust ANSI parsing |
| PTY | portable-pty (Rust crate) | Cross-platform with a stable API |
| Persistence | Local JSON files (`~/.flowmie/workspaces/*.json`) | Simple; no server or database required |
| Embedded webview | Tauri `WebviewBuilder` (child webview API) | Uses the same stack and avoids an additional dependency |

---

## 3. Suggested folder structure

```text
flowmie/
├── src/                          # React frontend
│   ├── components/
│   │   ├── canvas/
│   │   │   ├── Canvas.tsx
│   │   │   ├── TerminalNode.tsx
│   │   │   ├── WebviewNode.tsx
│   │   │   └── NoteNode.tsx
│   │   ├── toolbar/
│   │   │   └── NewNodeMenu.tsx
│   │   └── shared/
│   ├── hooks/
│   │   ├── usePty.ts
│   │   ├── useWebviewSync.ts
│   │   └── useWorkspace.ts
│   ├── types/
│   │   └── workspace.ts          # Shared types (mirror the Rust structs)
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── pty/
│   │   │   ├── mod.rs
│   │   │   └── manager.rs        # Manages active PTY processes
│   │   ├── webview/
│   │   │   └── manager.rs        # Manages child webviews and position synchronization
│   │   ├── workspace/
│   │   │   ├── mod.rs
│   │   │   └── persistence.rs    # JSON load/save
│   │   ├── commands.rs           # Tauri commands (invoke handlers)
│   │   ├── events.rs             # Events emitted to the frontend
│   │   └── main.rs
│   └── Cargo.toml
├── package.json
└── README.md
```

---

## 4. Data model

### 4.1 Workspace (persisted JSON file)

```typescript
interface Workspace {
  id: string;                  // UUID
  name: string;
  createdAt: string;           // ISO 8601
  updatedAt: string;
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

type CanvasNode = TerminalNodeData | WebviewNodeData | NoteNodeData;

interface BaseNode {
  id: string;                  // UUID
  position: { x: number; y: number };
  size: { width: number; height: number };
}

interface TerminalNodeData extends BaseNode {
  type: "terminal";
  agentType: "claude" | "codex" | "opencode" | "shell";
  role?: string;               // Custom instruction text injected on spawn
  cwd: string;                 // Working directory
  ptyId: string | null;        // Set at runtime; not persisted across restarts
}

interface WebviewNodeData extends BaseNode {
  type: "webview";
  url: string;
  label: string;               // e.g. "ChatGPT", "Gemini"
}

interface NoteNodeData extends BaseNode {
  type: "note";
  content: string;             // Markdown
  connectedTerminalId: string | null;
}

interface CanvasEdge {
  id: string;
  source: string;              // Node ID (must be a terminal)
  target: string;              // Node ID (must be a terminal, or a note for writing)
  direction: "source-to-target" | "bidirectional";
}
```

### 4.2 Rust — mirrored structs

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub viewport: Viewport,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CanvasNode {
    Terminal(TerminalNodeData),
    Webview(WebviewNodeData),
    Note(NoteNodeData),
}
```

All remaining structs mirror the TypeScript types above one-to-one.

---

## 5. IPC contracts (Tauri commands + events)

### 5.1 Commands (frontend → backend, via `invoke`)

| Command | Payload | Return value | Description |
|---|---|---|---|
| `pty_spawn` | `{ agentType, cwd, role? }` | `{ ptyId: string }` | Creates a new PTY process |
| `pty_write` | `{ ptyId, data: string }` | `void` | Sends input to the process |
| `pty_resize` | `{ ptyId, cols, rows }` | `void` | Resizes the PTY |
| `pty_kill` | `{ ptyId }` | `void` | Terminates the process |
| `webview_create` | `{ nodeId, url, x, y, width, height }` | `{ webviewLabel: string }` | Creates a positioned child webview |
| `webview_update_bounds` | `{ webviewLabel, x, y, width, height }` | `void` | Synchronizes the webview's position and size with the canvas node |
| `webview_destroy` | `{ webviewLabel }` | `void` | Removes the webview |
| `workspace_save` | `Workspace` | `void` | Persists the workspace as JSON |
| `workspace_load` | `{ workspaceId }` | `Workspace` | Loads a workspace |
| `workspace_list` | — | `WorkspaceSummary[]` | Lists saved workspaces |
| `connection_relay` | `{ edgeId, data: string }` | `void` | Relays data from one terminal to another (used internally by Phase 4) |

### 5.2 Events (backend → frontend, via `emit`)

| Event | Payload | Description |
|---|---|---|
| `pty://data` | `{ ptyId, data: string }` | New process output (continuous stream) |
| `pty://exit` | `{ ptyId, exitCode }` | Process exited |
| `pty://error` | `{ ptyId, message }` | Process error (e.g. command not found) |
| `webview://loaded` | `{ webviewLabel }` | Webview finished loading |
| `webview://error` | `{ webviewLabel, message }` | Webview failed to load |

---

## 6. Specification by phase

### Phase 1 — Single terminal

**Scope:**

- Implement `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, and the `pty://data` event
- Frontend: an isolated `TerminalNode.tsx` component (without the canvas for now) that renders xterm.js and connects to events through a Tauri listener
- No persistence yet

**Acceptance criteria:**

- [x] Opening the app automatically spawns the user's default shell
- [x] Commands work as expected (`ls`, `cd`, and opening and closing `vim`)
- [x] Resizing the app window resizes the PTY correctly without breaking the layout of programs such as `htop`
- [x] Terminating the process externally (e.g. `kill -9`) emits `pty://exit`, and the UI reflects it with a "process exited" message

---

### Phase 2 — Canvas with multiple terminals

**Scope:**

- Integrate React Flow
- Convert `TerminalNode.tsx` into a custom React Flow node
- Add a "new terminal" menu (simple dropdown: Claude / Codex / OpenCode / Shell) that calls `pty_spawn` with the corresponding `agentType`
- Keep canvas state (node positions) in memory using Zustand or the Context API
- Add basic persistence: save/load the layout via `workspace_save`/`workspace_load` without reconnecting PTYs yet. When reloaded, terminal nodes appear empty/"disconnected" and can be respawned manually

**Acceptance criteria:**

- [x] Multiple terminals can be created simultaneously, each working independently
- [x] Panning and zooming the canvas do not break xterm.js rendering within the nodes
- [x] Closing a node terminates its corresponding PTY (`pty_kill`)
- [x] Saving and reloading a workspace restores node positions

---

### Phase 3 — Webview node (ChatGPT/Gemini)

**Scope:**

- Implement `webview_create`, `webview_update_bounds`, and `webview_destroy`
- Implementation reference: study the Pake project's `src-tauri/src/` directory for its `WebviewBuilder` configuration pattern
- Unlike Pake, use a **child** webview positioned inside the main window rather than a separate `WebviewWindow`
- `WebviewNode.tsx`: an "empty" React Flow node that serves only as a visual placeholder. The real page is rendered by an overlaid native webview whose position and size are recalculated on every React Flow pan/zoom/drag event via `webview_update_bounds`
- Extend the "new node" menu with a "Web" submenu containing ChatGPT, Gemini, and Custom URL

**Known technical risks (allow extra time):**

- Coordinate synchronization between React Flow's logical space, which has its own zoom/pan system, and Tauri's absolute screen coordinates requires an independently tested conversion function
- Performance: repositioning the webview on every zoom frame may cause jank; consider debouncing or repositioning only when the gesture ends

**Acceptance criteria:**

- [ ] Creating a "ChatGPT" node loads the real, interactive page, including login and text input
- [ ] Moving the canvas node moves the webview correctly without perceptible delay
- [ ] Zooming the canvas resizes and repositions the webview without clipping or misalignment
- [ ] Closing the node destroys the webview (`webview_destroy`) without leaking a process

---

### Phase 4 — Connections between terminals

**Scope:**

- Restrict React Flow edges to `terminal` nodes, with client-side validation when a connection is attempted
- When an edge is created, the backend registers a relay: data received through `pty://data` from the source terminal is filtered and forwarded through `pty_write` to the target terminal
- Add an output sanitization module before relaying:
  - Remove ANSI escape sequences
  - Use a simple trimming heuristic, such as taking only the agent's latest complete response rather than its entire history. This will likely require tuning by `agentType`, since each CLI formats its output differently
- Add a UI toggle to enable or disable the active relay for each edge, which is useful for debugging

**Acceptance criteria:**

- [ ] When terminal A is connected to terminal B, a message entered manually in A appears as input in B after the agent finishes its response
- [ ] Disconnecting the edge stops the relay immediately
- [ ] No ANSI escape sequences leak into relayed text

---

### Phase 5 — Roles, notes, and complete persistence

**Scope:**

- Add a `role` field to `TerminalNodeData`: instruction text injected as the agent's first message via `pty_write` immediately after a successful `pty_spawn`
- Add `NoteNodeData`: an editable text node. When `connectedTerminalId` is set, relevant terminal output is appended to the note using the sanitization logic from Phase 4
- Add complete persistence: saved workspaces include `role`, `cwd`, and webview `url`. When reloaded, terminals are automatically respawned with the same `role`/`cwd`, and webviews reload the same URL

**Acceptance criteria:**

- [ ] A terminal created with the "Bug Whisperer" role automatically receives a corresponding initial instruction
- [ ] A note connected to a terminal receives text updates as the agent works
- [ ] Closing and reopening the app restores the complete workspace, respawns terminals, and reapplies roles
