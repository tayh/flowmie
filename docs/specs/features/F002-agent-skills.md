# Feature Spec — Agent Skills (Canvas-Aware Collaboration)

| Field | Value |
|---|---|
| ID | F002 |
| Status | planned |
| Milestone | v0.2 |
| Depends on | [F001](https://github.com/tayh/flowmie/blob/main/docs/specs/features/F001-agent-orchestration-canvas.md) |

## 1. Overview

F001 gives terminals a **passive** relay: when a source agent goes idle, its sanitized output is pushed to whatever it happens to be wired to. The agent itself is blind — it does not know another agent exists, cannot address one deliberately, and cannot ask for anything back.

**Skills** turn that passive pipe into an active capability. A skill is a tool the agent can call, on its own initiative, mid-task. Skills let an agent:

- **See the canvas** — enumerate the other agents in the workspace (role, type, working directory) and learn which of them it is connected to.
- **Talk to a peer** — send a directed message to a specific connected agent and, optionally, wait for a reply, instead of broadcasting into the idle relay.
- **Fetch resources** — pull a resource that lives on the canvas (an image, a screenshot from a webview, a note's text, a file) into its own context by path or inline.

The delivery mechanism is a **local MCP server** run by the Flowmie backend. Every coding agent Flowmie spawns (Claude Code, Codex, OpenCode) already speaks the Model Context Protocol, so exposing skills as MCP tools means no per-agent glue and no scraping of terminal output. The agent gets first-class tools; Flowmie is the server behind them.

> **The edge graph is the permission graph.** A skill call is authorized by the canvas topology: an agent may see, message, and read resources from another node only if an **enabled** edge (F001) connects them, respecting the edge's `direction`. Drawing a wire grants a capability; toggling it off (or deleting it) revokes it. This reuses the exact model users already understand from F001 relays and keeps the blast radius of any one agent visible and physical.

Product reference: Maestri (themaestri.app) — "agents that can see and talk to each other," Portals (agent-controllable embedded browsers with screenshot capture), and agent-written sticky notes.

---

## 2. Technical stack

| Layer | Technology | Rationale |
|---|---|---|
| Skill transport | MCP (Model Context Protocol) | Native to every supported coding agent; no output scraping and no bespoke protocol |
| MCP server | Rust, embedded in the Tauri backend (`rmcp` crate, stdio + local HTTP) | Same process that already owns PTYs, webviews, and workspace state — the single source of truth for topology |
| Agent identity | `FLOWMIE_NODE_ID` env var injected at `pty_spawn` | Lets the server map an incoming MCP session back to the exact canvas node that opened it |
| Resource store | Content-addressed blobs under `~/.flowmie/resources/` | Images/files handed to agents as real file paths (CLI agents read by path) and/or inline MCP image content |
| Screenshot capture | Tauri/`wry` webview capture (see F001 Phase 3 webview manager) | Reuses the existing native-webview plumbing to turn a Portal into an image resource |

---

## 3. How an agent gets its skills

Skills are configured per terminal at spawn time, keyed by `agentType`, so each CLI receives MCP config in its own format:

| `agentType` | Wiring |
|---|---|
| `claude` | Spawned with `--mcp-config <per-node file> --strict-mcp-config`; tools appear as `mcp__flowmie__*` |
| `codex` | Registered per-invocation via `codex -c mcp_servers.flowmie.*` config overrides (merges with the user's config, never mutates `~/.codex/config.toml`); identity baked into the server's `env` |
| `opencode` | MCP server declared in OpenCode's config (not yet wired — OpenCode isn't installed here) |
| `shell` | No skills (not an agent) |

In all cases the backend:

1. Starts (or reuses) the local MCP server.
2. Spawns the PTY with `FLOWMIE_NODE_ID=<terminal node id>` in its environment.
3. Points the agent's MCP config at the server.

When the agent later calls a skill, the server reads `FLOWMIE_NODE_ID` from the originating session to know **which node is asking**, then answers using live workspace state.

A per-terminal **Skills** toggle (default on for agent types, off for `shell`) controls whether the MCP config is injected at all — the escape hatch, mirroring F001's per-edge relay toggle.

---

## 4. The skills (MCP tools)

All tools are scoped to the caller (`FLOWMIE_NODE_ID`) and filtered by the enabled-edge topology. Names below are the logical tool names; the Claude-facing names are prefixed `mcp__flowmie__`.

| Skill | Arguments | Returns | Description |
|---|---|---|---|
| `whoami` | — | `{ nodeId, role, agentType, cwd, label }` | The caller's own identity as it sits on the canvas |
| `list_agents` | `{ connectedOnly?: boolean }` | `AgentInfo[]` | Terminal agents in the workspace. Each entry: `{ nodeId, role, agentType, label, connected, direction, canSend, canReceive }`. With `connectedOnly` (default `true`), only peers reachable by an enabled edge |
| `get_connections` | — | `Connection[]` | The caller's edges: `{ edgeId, peerNodeId, direction, enabled }` — an agent's local view of the topology |
| `send_message` | `{ toNodeId, text, resourceIds?: string[] }` | `{ delivered: boolean, messageId }` | Deliver a directed message to a **connected** peer's input. Optional resource attachments are surfaced to the peer as fetchable ids |
| `reply` | `{ text }` | `{ delivered, toNodeId, messageId }` | Answer the agent that most recently messaged the caller — **no node id required**. Added after live testing showed peers reliably fail to pass back a correct `toNodeId`; the bridge routes the reply to the last sender |
| `wait_for_reply` | `{ sinceMessageId, timeoutMs?: number }` | `{ text, fromNodeId } \| { timedOut: true }` | Block until the addressed peer next produces a relayed response, or time out. Lets an agent delegate and await a result |
| `list_resources` | `{ nodeId?: string }` | `ResourceRef[]` | Resources available to the caller: attachments on connected nodes, note contents, and webview screenshots. Each: `{ resourceId, kind, mime, label, ownerNodeId }` |
| `get_resource` | `{ resourceId, as?: "path" \| "inline" }` | `{ path } \| { content }` | Materialize a resource. `path` writes it under `~/.flowmie/resources/` and returns the local path (default for large/binary blobs); `inline` returns MCP text or image content directly |
| `capture_webview` | `{ nodeId }` | `{ resourceId, path }` | Screenshot a connected webview (Portal) node and register it as an image resource — how an agent "gets an image" of a running page |
| `share_resource` | `{ kind, mime, label, dataBase64 \| path }` | `{ resourceId }` | Publish a resource (e.g. a screenshot the agent produced, a generated image, a file) so connected peers can `get_resource` it |

`kind` ∈ `"image" | "text" | "file"`. Unknown/oversized resources are always returned `as: "path"`.

---

## 5. Data model changes

Additive; existing F001 workspaces stay valid.

```typescript
interface TerminalNodeData extends BaseNode {
  type: "terminal";
  agentType: "claude" | "codex" | "opencode" | "shell";
  role?: string;
  cwd: string;
  ptyId: string | null;
  skillsEnabled?: boolean;   // default: true for agents, false for shell (F002)
}

// Resources are content-addressed and live outside the node graph so they
// can be shared, captured, and garbage-collected independently.
interface ResourceRef {
  id: string;                // UUID
  kind: "image" | "text" | "file";
  mime: string;              // e.g. "image/png", "text/markdown"
  label: string;             // human/agent-readable name
  ownerNodeId: string | null;// node that produced it (null = user-dropped)
  createdAt: string;         // ISO 8601
  // On disk: pointer to blob under ~/.flowmie/resources/<hash>; not inlined
  // into the workspace JSON.
  path: string;
}

interface Workspace {
  // ...existing F001 fields...
  resources: ResourceRef[];  // F002; defaults to [] when absent
}
```

A message is **not** persisted state — it is an ephemeral delivery. `send_message` writes the peer's PTY exactly as F001's relay does (sanitized text + trailing carriage return to submit), so no message log is added to the workspace file.

### Rust — mirrored structs

`ResourceRef` and the `skills_enabled` field mirror the TypeScript above one-to-one; `Workspace` gains `resources: Vec<ResourceRef>` with `#[serde(default)]` so pre-F002 files deserialize cleanly.

---

## 6. IPC contracts (additions to F001 §5)

### 6.1 Commands (frontend → backend, via `invoke`)

| Command | Payload | Return value | Description |
|---|---|---|---|
| `skills_server_ensure` | — | `{ endpoint: string }` | Idempotently starts the local MCP server; returns its address for spawn wiring |
| `resource_register` | `{ kind, mime, label, ownerNodeId, dataBase64 \| srcPath }` | `ResourceRef` | Stores a blob content-addressed and returns its ref |
| `resource_read` | `{ resourceId, as }` | `{ path } \| { content }` | Backing implementation shared by the `get_resource` skill and the UI |
| `webview_capture` | `{ nodeId }` | `ResourceRef` | Captures a webview node to a PNG resource (used by `capture_webview`) |

`pty_spawn` (F001) gains optional `skillsEnabled` and, internally, injects `FLOWMIE_NODE_ID` plus the agent-appropriate MCP config.

### 6.2 Events (backend → frontend, via `emit`)

| Event | Payload | Description |
|---|---|---|
| `skill://invoked` | `{ nodeId, skill, targetNodeId? }` | An agent called a skill — drives the canvas activity indicator (§7) |
| `skill://message` | `{ fromNodeId, toNodeId, messageId }` | A directed `send_message` was delivered — animates the edge |
| `resource://created` | `{ resourceId, ownerNodeId }` | A new resource is available — refresh resource affordances |

---

## 7. UX

- **Skill activity on the canvas.** When an agent calls a skill, its node pulses; `send_message` animates the connecting edge in the message's direction (distinct from the F001 idle-relay animation) so directed traffic is visually different from passive relay.
- **Resource tray.** Screenshots and shared files appear as small chips on their owner node; users can drag a chip onto a note or another node, and can drop an image from the OS onto the canvas to create a user-owned `ResourceRef`.
- **Skills toggle.** The terminal node's context menu gets a "Skills" switch alongside the existing role/relay controls; off strips MCP config on the next spawn.
- **Topology honesty.** Because permissions follow enabled edges, `list_agents` and `get_connections` results match exactly what the user sees wired on the canvas — no hidden back-channels.

---

## 8. Specification by phase

### Phase 1 — MCP server + canvas introspection

**Scope:**

- Embed the MCP server in the Rust backend (`skills_server_ensure`); expose it over stdio and a local HTTP endpoint.
- Inject `FLOWMIE_NODE_ID` and agent-appropriate MCP config at `pty_spawn`, gated by `skillsEnabled`.
- Implement read-only skills: `whoami`, `list_agents`, `get_connections`, backed by live `useWorkspace` state read through a backend view of the topology.
- Enforce the enabled-edge permission filter in `list_agents`/`get_connections`.

**Acceptance criteria:**

- [x] A Claude Code agent spawned by Flowmie lists `mcp__flowmie__*` tools and `whoami` returns its own role/cwd
- [x] `list_agents` returns exactly the peers reachable by enabled edges; disabling an edge removes the peer on the next call
- [x] A `shell` node (skills off) is spawned without any MCP config and appears in no agent's `list_agents`

**Known technical risks:**

- Mapping an inbound MCP session to its originating node depends on env-var inheritance surviving the PTY spawn; verify per `agentType`, since each CLI resolves MCP config and env differently.

**Implementation notes (as built):**

- **Transport:** rather than an embedded `rmcp` server, the MCP server is a dependency-free Node stdio shim (`mcp-server/flowmie-mcp.mjs`) that speaks newline-delimited JSON-RPC by hand (`initialize` / `tools/list` / `tools/call`) and forwards each tool call to a minimal localhost bridge (`tiny_http`) in the Rust backend (`src-tauri/src/skills/`). Chosen for testability and to avoid pulling an async runtime into the sync Tauri backend.
- **Identity without env-inheritance risk:** the node id / bridge URL / token are baked into the `env` block of the per-node MCP config file (`~/.flowmie/mcp/<nodeId>.json`) that Claude loads via `--mcp-config … --strict-mcp-config`, so the shim's identity does not depend on the PTY inheriting env vars. The same values are also exported as `FLOWMIE_*` env vars on the process as a foundation for codex/opencode.
- **Topology source of truth:** the graph lives in the frontend store, so `useSkillsSync` debounce-pushes a compact `{terminals, edges}` snapshot to the backend (`skills_sync_topology`) on every node/edge change; the bridge answers from that cache. The enabled-edge permission logic (`agents_for` / `connections_for`) is pure and unit-tested in `skills/mod.rs`.
- **Auth:** every bridge request must carry the shared token in `X-Flowmie-Token`; the bridge binds an ephemeral `127.0.0.1` port only.
- **Codex now wired (was deferred):** Codex is registered per-invocation via `codex -c mcp_servers.flowmie.command/args/env.*` overrides (`codex_skills_args`), verified with `codex mcp list`/`get` showing `flowmie` enabled with the baked-in env. Only OpenCode remains unwired (not installed here). The per-terminal Skills toggle UI from §7 is still deferred (the `skillsEnabled` field + default-on-for-agents already exist and persist).
- **Verified:** `cargo test` (6 skills unit tests), full `tsc` + `vitest` (24), and an end-to-end MCP handshake driving the real shim against a stub bridge (initialize → tools/list → whoami/list_agents/get_connections → unknown-tool error), confirming tool calls reach the bridge with the correct node id and token. Live `claude`-in-the-app tool invocation was also confirmed: a real Claude node discovered `mcp__flowmie__whoami` and got back its own identity.

---

### Phase 2 — Directed messaging

**Scope:**

- Implement `send_message` (deliver to a connected peer's PTY via the F001 write path, sanitized + submit) and `wait_for_reply` (resolve on the addressee's next relayed idle-flush from `useRelay`, or time out).
- Emit `skill://message`; animate the edge directionally.
- Reject sends to non-connected or relay-disabled peers with a clear tool error the agent can act on.

**Acceptance criteria:**

- [x] Agent A calling `send_message(toNodeId=B, ...)` causes the text to appear as input in B, only when an enabled A→B (or bidirectional) edge exists
- [x] `send_message` to an unconnected peer returns an authorization error, not a silent no-op
- [x] `wait_for_reply` resolves with B's next response, or reports `timedOut` after the timeout

**Implementation notes:**

- Directed messaging and the F001 passive relay share the same sanitize/submit path (`src/lib/sanitize.ts`); the difference is *who initiates* — an explicit tool call vs. the idle-flush in `useRelay.ts`. `wait_for_reply` hooks the same idle-flush the relay already computes rather than adding a second detector.

**Implementation notes (as built):**

- **`send_message`** is `POST /message` on the bridge. It checks `can_send(caller → target)` against the live topology (403 if not connected), resolves the target's PTY id, sanitizes the text into a single submittable line (`sanitize_message`: control chars → spaces so an embedded newline can't submit early), writes `"<text>\r"` via `PtyManager`, emits `skill://message`, and returns `messageId = "<targetNodeId>@<seq-watermark>"`.
- **`wait_for_reply`** is `GET /reply` and long-polls on its own thread (so it never stalls the single-threaded `tiny_http` loop) until the target's response log advances past the message's watermark, or the timeout elapses (`{timedOut:true}`). It requires `can_receive(caller ← target)` — the permission is symmetric with the relay's data-flow direction.
- **Explicit reply channel (revised — see below):** replies are the peer's *exact* `send_message` back to the caller, recorded in a bridge-side message log — not scraped terminal output. `wait_for_reply` scans that log for "a message from the peer I messaged, to me, after my message."
- **Watermark semantics:** `send_message` records its message and uses that message's sequence as the reply watermark; the peer's reply necessarily gets a higher sequence, so a stale prior message from the peer never resolves the wait.
- **UX:** `skill://message` drives a directional dash-flow animation on the crossed edge (`useSkillActivity` + `RelayEdge`), visually distinct from the static relay edge.
- **Known interaction:** because receiving a reply requires an inbound/bidirectional edge, and that same edge also makes the peer a passive-relay source, a bidirectional pairing delivers the peer's response both as terminal input (F001 relay) and as the `wait_for_reply` result. This is inherent to "edge = permission" and acceptable.
- **Delivery framing (bug fix):** live testing showed a message written to a TUI agent (Codex/Claude) arriving with characters dropped ("that it's a" → "thatit'sa") and the agent never cleanly submitting — writing a burst of raw bytes makes a raw-mode TUI drop keystrokes. Fixed by `PtyManager::submit_message`: TUI agents (`claude`/`codex`/`opencode`) now receive the text via **bracketed paste** (`ESC[200~ … ESC[201~`) — inserted atomically — followed by a submitting CR; a plain shell still gets `text + \r`. Both delivery paths (the F001 relay via the new `pty_submit` command, and `send_message` in the bridge) share this, so the fix is uniform. Framing is unit-tested (`submission_payload`).
- **Edge direction control (usability gap):** the relay edge previously had no UI to become bidirectional, so `wait_for_reply` / two-way conversations were unreachable from the canvas. `RelayEdge` now has a direction toggle (`→` one-way / `⇄` two-way, `toggleEdgeDirection`) beside the on/off switch.
- **`wait_for_reply` messageId decode (bug fix):** the shim URL-encodes tool arguments, so the `<nodeId>@<seq>` messageId arrived at the bridge with the `@` as `%40`; the query parser didn't percent-decode, so `handle_reply` rejected every id as malformed. Fixed by percent-decoding query components in the bridge (`percent_decode`); tested from encoded URL through to a resolved reply. (Phase 1 tools never hit this — UUIDs/bools have no characters `encodeURIComponent` touches.)
- **Screen-scraping noise, resolved by decoupling from the F001 relay:** live testing confirmed the earlier limitation biting hard — a bidirectional edge turned on the F001 passive relay in both directions, and scraping two full-screen TUIs (`trimResponse` only strips ANSI, not screen furniture) flooded each terminal with the other's boot lines, spinner frames, and input-bar footers ("passing all logs from one terminal to another"). Fixed structurally, not heuristically:
  - **Replies are now explicit.** The bridge keeps a message log of directed `send_message` calls; `wait_for_reply` resolves on the peer's *exact* message back to the caller. Delivered messages are framed with the sender's id and a "reply via send_message" hint so the peer answers through the clean channel. (`skills_record_response` and the relay→bridge response feed were removed.)
  - **Skill-enabled agents are never scraped.** `useRelay` now skips buffering/forwarding any skill-enabled source (`isSkillEnabled`), so an agent's raw TUI stream is never relayed. The F001 passive scrape-relay remains only for non-skill sources (e.g. a plain shell, whose line output is meaningfully forwardable) and for terminal→note.
  - **Tradeoff:** a skill-enabled agent connected to a note no longer auto-appends scraped output to it (it would have been TUI garbage anyway); notes are still fed by non-skill sources. Documented as intentional.
- **`reply` skill — id-free replies (bug fix):** with the explicit channel, a round-trip requires the peer to send back to the sender's node id. Live testing showed peers can't do this reliably — Codex composed a correct reply but reached for its own `codex_apps` agent registry / searched by name and never found the id. Fixed by adding a `reply(text)` skill: the bridge routes it to whoever most recently messaged the caller (`last_sender_to`), so the peer needs no id. Delivered messages now instruct "call the flowmie `reply` skill" rather than quoting an id. `send_message` and `reply` share one `deliver` path.
- **Verified:** 12 Rust unit tests (permission direction, `sanitize_message`, and real-timing `wait_for_reply` resolve/timeout/denied/malformed); an extended MCP e2e harness driving the real shim for `send_message` (authorized + 403-rejected) and `wait_for_reply` (resolve + timeout) with correct POST-body/query shaping; `tsc` + `vitest` (24) green. Live agent-to-agent delegation in the app is the remaining manual check.

---

### Phase 3 — Resources (images and files)

**Scope:**

- Implement the resource store (`resource_register`/`resource_read`, `~/.flowmie/resources/`, content addressing) and the `list_resources` / `get_resource` / `share_resource` skills.
- Implement `capture_webview` / `webview_capture` on top of the F001 native-webview manager to screenshot a Portal into an image resource.
- Note contents and dropped images surface as resources; add the resource-tray UX (§7).
- Persist `ResourceRef`s in the workspace with `#[serde(default)]`; blobs live outside the JSON.

**Acceptance criteria:**

- [ ] An agent calls `capture_webview` on a connected ChatGPT/Gemini Portal and then `get_resource` to read the PNG (by path or inline image content)
- [ ] `share_resource` from agent A produces a `resourceId` that connected agent B can `get_resource`; an unconnected agent cannot
- [ ] Closing and reopening the app restores `ResourceRef`s and their blobs remain readable

**Known technical risks:**

- Inline image content is only useful to agents whose CLI renders MCP image results; default to `as: "path"` and let vision-capable agents request `inline`.
- Webview capture on Linux uses the bespoke `wry`+`gtk` overlay path from F001 Phase 3, not Tauri's `add_child`; the capture surface must target that overlay's actual widget.
