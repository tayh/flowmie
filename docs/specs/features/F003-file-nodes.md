# Feature Spec — File Nodes (Files and Folders on the Canvas)

| Field | Value |
|---|---|
| ID | F003 |
| Status | Phase 1 built (pending live check); Phases 2–3 built |
| Milestone | v0.3 |
| Depends on | [F001](https://github.com/tayh/flowmie/blob/main/docs/specs/features/F001-agent-orchestration-canvas.md), [F002](https://github.com/tayh/flowmie/blob/main/docs/specs/features/F002-agent-skills.md) |

## 1. Overview

F002 Phase 3 gave agents a resource store, a `get_resource` skill, and a canvas drop handler. What it did **not** give the user is a way to *see* a file on the canvas or *wire* it to an agent. A dropped file today:

- **Renders nowhere.** `ResourceTray` only draws chips whose `ownerNodeId === nodeId` (`ResourceTray.tsx:27`), and a dropped file is registered with `ownerNodeId: null` (`Canvas.tsx:103`). It has no owner node, so no tray ever shows it.
- **Ignores the permission graph.** `can_access_resource` returns `true` for *any* caller when `owner == None` (`skills/mod.rs:225`). A dropped file is readable by every agent in the workspace, wired or not — the one place F002's "the edge graph is the permission graph" rule is not enforced.
- **Is probably unreachable anyway.** See §9 — Tauri's `dragDropEnabled` defaults to `true`, which suppresses the HTML5 `drop` event the handler is bound to.

**File nodes** close this. A file or folder becomes a first-class canvas node with handles, wired to agents by the same relay edge as everything else. The node *is* the grant: connect it to an agent and that agent can read it; disconnect it and the agent cannot.

> **A file node is a live pointer, not a copy.** The node stores the absolute path. `get_resource` reads the file from disk *at call time*, so editing a file in your editor means the connected agent sees the edit on its next read — no re-drop, no stale snapshot. This is the opposite of the existing blob path (`share_resource`, `capture_webview`), which content-addresses immutable bytes, and deliberately so: those capture a moment, a file node tracks a document.

Product reference: Maestri's canvas file attachments; the mental model is "drag a file onto the board and draw a line to whoever should read it."

---

## 2. Technical stack

| Layer | Technology | Rationale |
|---|---|---|
| Node type | React Flow custom node (`file`), mirroring `note` | Same shape as every existing node; no new canvas machinery |
| File picker | `tauri-plugin-dialog` (`open({ directory })`) | The only supported way to get an **absolute path** from a user choice |
| Drag from OS | `getCurrentWebview().onDragDropEvent()` | Tauri's native drag-drop; unlike an HTML5 drop it carries real paths (§9) |
| Reads | Synthetic `file:<nodeId>` resource resolved from the topology snapshot | Exactly the `note:<id>` live-resource pattern (`bridge.rs:151`, `:413`) — no store, no blob, no copy |
| Permission | `can_reach` over enabled edges | A file is passive, like a Portal; a wire in either orientation grants a read |

No new MCP tools. Agents already have `list_resources` and `get_resource`; file nodes simply appear in them.

---

## 3. Data model changes

Additive; existing F001/F002 workspaces stay valid.

```typescript
interface FileNodeData extends BaseNode {
  type: "file";
  path: string;          // absolute; the live pointer
  label: string;         // basename by default, user-renamable
  isDirectory: boolean;  // resolved at add time, re-checked on read
}
```

`CanvasNode` gains `FileNodeData`; `Workspace.nodes` needs no other change. Rust mirrors this in `workspace/mod.rs`, and the bridge gains a `FileInfo` in `Snapshot` alongside `NoteInfo`:

```rust
pub struct FileInfo {
    pub id: String,
    pub path: String,
    pub label: String,
    #[serde(rename = "isDirectory", default)]
    pub is_directory: bool,
}
```

Nothing is written to `~/.flowmie/resources/` — a file node has no blob. `useSkillsSync.buildSnapshot` grows a `files` array next to `notes`.

---

## 4. The skills (no new tools)

| Skill | Behaviour with file nodes |
|---|---|
| `list_resources` | Connected file nodes appear as `{ resourceId: "file:<nodeId>", kind, mime, label, ownerNodeId: <fileNodeId> }`. A folder is one entry (`kind: "file"`, `mime: "inode/directory"`), not one per member |
| `get_resource` | `file:<nodeId>` → the file. `as: "path"` (default) returns the **real absolute path**, so a CLI agent reads it with its own tools and no copy is made. `as: "inline"` returns text content, or an image block for images |
| `get_resource` (folder) | `file:<nodeId>` on a directory returns a text listing (relative paths, depth-capped). `file:<nodeId>/<relative>` reads one member — the only way to address inside a folder |

`kind`/`mime` are inferred from the extension by the existing `kindForMime` logic, lifted out of `Canvas.tsx` into `src/lib/fileKind.ts` so Rust-side and UI-side inference agree.

### Guards

- **Traversal.** `file:<id>/<relative>` is canonicalized and must remain inside the node's canonicalized root; `..`, absolute components, and symlinks escaping the root are rejected `403`. This is the one genuinely new attack surface in F003 and is unit-tested directly.
- **Size.** Inline reads are capped (1 MiB); over the cap, and for any binary mime, the result is forced to `as: "path"` — matching F002 §4's existing "unknown/oversized resources are always returned `as: path`" rule.
- **Missing.** A path that no longer exists returns `404` with the path in the message, and the node renders a "missing" state rather than silently reading nothing.
- **Listing.** Directory listings are capped (depth 3, 1000 entries) and skip `.git`/`node_modules`; truncation is stated in the output so the agent knows it is partial.

---

## 5. Permission model

`can_access_resource` loses its `None => true` arm:

```rust
match owner {
    Some(o) if o == caller => true,
    Some(o) => can_receive(snapshot, caller, o),   // blobs: owner → caller
    None => false,                                  // was: true
}
```

A file node's read is authorized by `can_reach(snapshot, caller, file_node_id)` — direction-agnostic, mirroring `capture_webview`, because a file (like a Portal) is a passive thing an agent reaches for rather than a peer that pushes data. Drawing the wire either way grants the read; disabling the edge revokes it on the next call.

**Migration.** Any pre-F003 resource persisted with `ownerNodeId: null` becomes unreadable. Those are exactly the invisible dropped files from §1 — they render nowhere and are almost certainly unreachable in practice (§9), so this strands nothing a user can see. `skills/mod.rs:443`'s `assert!(can_access_resource(&s, "b", None))` inverts.

---

## 6. UX

- **Adding.** Drag a file or folder from the OS onto the canvas → a file node at the drop point. Or **New ▸ File** in `NewNodeMenu`, which opens a native picker (file *or* folder).
- **The node.** Kind icon, filename, dimmed parent directory, and a folder/file badge. Click opens the file in the OS default app (`opener`), matching chip behaviour. Renaming edits `label` only — never the path.
- **Wiring.** Handles on both sides; `onConnect` accepts file↔terminal, rejects file↔file, file↔note, file↔webview.
- **Missing state.** If the path is gone at read or reveal time, the node goes red with "file not found" and a **Locate…** action to re-point it.
- **Honesty.** An unwired file node is visibly inert: no agent can see it in `list_resources`. The wire is the whole grant, and you can see it.

---

## 7. IPC contracts (additions to F002 §6)

### 7.1 Commands

| Command | Payload | Return | Description |
|---|---|---|---|
| `file_stat` | `{ path }` | `{ exists, isDirectory, size, mime }` | Resolves a path at add time so the node knows what it is; also drives the missing state |

`skills_sync_topology` (F002) gains `files` in its snapshot. No new events.

### 7.2 Capabilities

`dialog:allow-open` is added to `capabilities/default.json`. Note that `opener:allow-open-path` is currently scoped to `$HOME/.flowmie/resources/**` (uncommitted change, already in the working tree) — click-to-open on a file node needs that scope widened to `$HOME/**`, which is a deliberate and reviewable widening.

---

## 8. Specification by phase

### Phase 1 — File nodes, single files

**Scope:**

- `FileNodeData` + Rust mirror; `FileNode.tsx`; `onConnect` validation; `file_stat`.
- Both add paths: native drag-drop (`onDragDropEvent`) and the `NewNodeMenu` picker.
- `file:<nodeId>` in `list_resources` / `get_resource`, gated by `can_reach`.
- Tighten `can_access_resource`; retire the dead `ownerNodeId: null` drop path in `Canvas.tsx`.

**Acceptance criteria:**

- [~] Dropping a file on the canvas creates a node at the drop point holding its absolute path — *built; the drop gesture itself needs a human at a GTK display (see "Remaining manual checks")*
- [~] A connected agent's `list_resources` shows the file; `get_resource(as:"path")` returns the real path and the agent reads it — *every layer unit-tested; the live agent round-trip is a manual check*
- [x] Editing the file on disk changes what the agent reads next — no re-drop (`files::tests::read_inline_returns_text_and_tracks_edits_on_disk` reads, rewrites, and re-reads)
- [x] An **unconnected** agent does not see the file in `list_resources` and gets `403` from `get_resource`; disabling the edge revokes access on the next call (`file_read_is_denied_without_an_edge`, `disabling_the_edge_revokes_the_file_read`)
- [~] A deleted file yields `404` and the node shows its missing state — *the `404` is tested (`read_errors_on_missing_and_directories`); the node's red state is unverified pixels*

**Implementation notes (as built):**

- **Live reads live in `src-tauri/src/files/mod.rs`**, deliberately *not* in `resources/`: the two models are opposites (immutable content-addressed copy vs. live pointer) and fusing them would have meant a `ResourceStore` entry whose bytes can change under it. `files::read` returns the existing `ReadResult` enum, so the shim, the bridge, and MCP clients needed no new result shape.
- **`as: "path"` returns the original path, not a copy.** This is the payoff of the live-pointer model: a CLI agent gets `/home/tayh/spec.md` and reads it with its own tools. `as: "inline"` returns text or a base64 image, and falls back to a path for binary, for anything over `MAX_INLINE_BYTES` (1 MiB), *and* for non-UTF-8 content masquerading as text (a `.md` that isn't) — a mislabelled file degrades to a path instead of failing the agent's read.
- **Mime inference is duplicated on purpose** (`src/lib/fileKind.ts` and `files::mime_for_path`). The UI needs it with no IPC round-trip to pick an icon; the bridge needs it to decide what may be inlined. Both sides are unit-tested against the same table, and each references the other so a drift shows up as a failing test rather than an agent being denied an inline read the UI implied it would get.
- **Permission: `can_reach`, not `can_receive`.** A file is passive like a Portal, so a wire in either orientation grants the read, and both handles are drawn on the node. The decision is a pure function (`resolve_file_read`) split out of the handler precisely so it could be tested without an `AppHandle` — matching how the rest of the bridge's logic is tested.
- **`can_access_resource` lost its `None => true` arm**, closing the F002 hole where an ownerless resource was readable by every agent. Its unit test now asserts the inverse. Blast radius is limited to resources with `ownerNodeId: null`, which were only ever produced by the dead drop handler this phase removed.
- **Drag-drop is Tauri-native** (`useFileDrop`), replacing the HTML5 handler in `Canvas.tsx`. `onDragDropEvent` reports **physical** window pixels, so the drop point goes through a new `windowPointToFlowPosition` — the inverse of `flowNodeToWindowBounds`, including the device-pixel-ratio divide that the spec called out as the likely HiDPI bug. It is unit-tested, including a round-trip against its forward counterpart.
- **`Locate…` was pulled forward from Phase 3.** The missing state is reachable from day one (any file can be deleted behind the app's back), and a dead-end red node with no way out isn't shippable. `relocateFile` keeps the node's id, so the **edges survive** — re-pointing a moved file doesn't silently rebuild an agent's permissions.
- **Verified:** 40 Rust unit tests (8 new in `files`, 5 new bridge file-permission tests, 27 pre-existing) and 51 frontend tests (`fileKind`, `windowPointToFlowPosition`, and `buildSnapshot` — the last covering the topology push, without which every file node would be silently invisible to the bridge); `tsc` clean; production `vite build` clean; full `cargo build --bins` clean, which is what validates `dialog:allow-open` against the capability schema.

**Remaining manual checks** (need a human at a GTK display — `npm run tauri dev`):

1. Drag a file from the file manager onto the canvas: a node appears **under the cursor** (this is what exercises the physical→flow conversion; if it lands offset, suspect the DPI divide).
2. **New ▸ File ▸ File…/Folder…** opens the native picker and pins the choice.
3. Wire the node to a Claude agent and ask it to `list_resources` / `get_resource` — confirm it reads the real path and sees an edit made after wiring.
4. Confirm the F002 resource **chip drag** still works (it shares the HTML5 DnD mechanism the native handler sits beside).

### Phase 2 — Folders

**Scope:**

- `isDirectory` nodes: capped/filtered listing from `get_resource("file:<id>")`.
- Member reads via `file:<id>/<relative>` with the canonicalized containment check.

**Acceptance criteria:**

- [x] `get_resource` on a folder node returns a listing; a large tree is truncated and says so (`files::tests::list_dir_walks_capped_and_filtered`, `list_dir_states_truncation`, `list_dir_stops_at_max_depth`)
- [x] `file:<id>/src/main.rs` reads that member; `file:<id>/../../.ssh/id_rsa` is rejected `403` (`read_member_reads_a_file_inside_the_folder`, `read_member_rejects_parent_traversal`, `read_member_rejects_absolute_paths`)
- [x] A symlink inside the folder pointing outside it is rejected (`read_member_rejects_symlink_escaping_the_root`)

**Implementation notes (as built):**

- **Listing and member reads live in `files/mod.rs`** next to the Phase 1 single-file read — the same live-pointer model, just walking a tree. `list_dir` does a sorted depth-first walk capped at `MAX_LIST_DEPTH` (3) and `MAX_LIST_ENTRIES` (1000), skips `.git`/`node_modules`, and appends a "truncated at N entries" line when the cap trips so the agent knows the listing is partial. Directories keep a trailing `/`.
- **The traversal guard is `read_member`.** `<relative>` comes straight from an agent's tool call, so containment is checked against the **canonicalized** root and member (symlinks already resolved), not the textual join: a member whose canonical path does not `starts_with` the canonical root is rejected `Escapes`→403. Hostile *shapes* (`..`, absolute, Windows prefixes) are also rejected up front by a component check before touching disk. A symlink inside the folder pointing out is caught by the canonical-prefix check. `MemberError` splits `Escapes` (403) from `RootMissing`/`NotFound` (404) so the agent can tell "not allowed" from "not there". All four guards are unit-tested directly (incl. a real symlink under `#[cfg(unix)]`).
- **Bridge routing:** `handle_get_resource` splits `file:<nodeId>` from an optional `/<relative>` on the first `/` (node ids are UUIDs, so the first slash is unambiguous). A bare folder node lists; `file:<id>/<relative>` reads a member (a directory member returns its own listing); a member path on a *non*-folder node is a 400. The permission gate (`resolve_file_read` → `can_reach`) is unchanged and still runs first, so folders are edge-gated exactly like files. The shim's `get_resource` description now documents the folder + member syntax.
- **Verified:** `cargo test` — 56 unit tests (10 new `files` tests for listing/member/traversal, the Phase-1 folder-rejection bridge test rewritten to assert folders now resolve and stay edge-gated); `tsc` clean; `vitest` 51 green. No frontend change: folder nodes already render from Phase 1's `isDirectory`.

### Phase 3 — Polish

**Scope:** Locate…/re-point, rename, drag an existing resource chip onto a file node, folder ignore-rule config.

**Implementation notes (as built):**

- **Locate…/re-point** already shipped in Phase 1 (`relocateFile` keeps the node id so edges survive) — see that phase's notes. Nothing to add.
- **Rename** edits `label` only, never the path (UX §6). Double-clicking the label turns it into an inline input committed on blur/Enter (Escape cancels); a blank label falls back to the basename via `renameFileNode`, so a node never renders nameless. The label already persists (it is in `FileNodeData`), so no persistence change was needed.
- **Folder ignore-rule config.** `FileNodeData` gains an optional `ignore?: string[]` (persisted; folder nodes only). A folder node shows a compact comma-separated "ignore" input; `setFileIgnore` normalizes it (trim, drop blanks, `undefined` when empty). The patterns ride the topology snapshot (`buildSnapshot` sends `ignore: … ?? []`) into `FileInfo.ignore` (`#[serde(default)]`, so pre-Phase-3 files load clean) and reach `list_dir`/`read_member`. They are **additive to** the built-in `.git`/`node_modules`, which are always skipped — the config extends the defaults rather than replacing them (nobody wants `.git` listed). Unit-tested end to end: `files::tests::list_dir_honours_extra_ignore_patterns` (Rust) and a `buildSnapshot` passthrough test (frontend).
- **Drag a resource chip onto a file node — deliberately not built.** The chip-reshare mechanism (`useResourceDropTarget`) mints a *new* store `ResourceRef` owned by the drop-target node, so the target's agent can `get_resource` it. A file node owns no store resource — it is a live pointer resolved from the topology snapshot (`file:<id>`), with no blob and no owning agent — so "reshare onto it" has no coherent meaning: there is nothing for the file node to own or serve. Left out rather than given a no-op affordance that would imply a capability the model doesn't have. (The reverse — wiring a file node to an agent — is the actual grant, and already works.)
- **Verified:** `cargo test` — 57 unit tests (1 new: extra-ignore); `tsc` clean; `vitest` 52 (1 new: ignore passthrough; the stale "reject reads until Phase 2" folder test renamed); production `vite build` clean.

**Remaining manual checks** (need a human at a GTK display — `npm run tauri dev`):

1. Double-click a file node's name and rename it — the label changes, the path (hover tooltip) does not, and the new name survives a reload.
2. On a folder node, set `ignore` to e.g. `dist, target` and confirm a connected agent's `get_resource("file:<id>")` listing omits those directories while still hiding `.git`/`node_modules`.

---

## 9. Known technical risks

- **The existing drop handler was replaced, and was probably dead.** `dragDropEnabled` is unset in `tauri.conf.json`, and `drag_drop_enabled` defaults to `true` — **confirmed** in `tauri-utils-2.9.3/src/config.rs:1946` and `WindowConfig::default` (`:2301`). With it on, Tauri handles OS file drops natively. Whether that fully suppresses the HTML5 `drop` on **Linux** is *not* confirmed: the upstream doc only states that disabling it is required for HTML5 DnD *on Windows*. So "F002's canvas drop never worked" remains a strong suspicion, not a proven fact — it is consistent with that handler's blob rendering nowhere (§1), which would have hidden the failure. It does not affect the design either way: an HTML5 drop cannot yield an absolute path, so F003 needs `onDragDropEvent` regardless, and the old handler is gone rather than left to double-fire.
- **Internal chip drags share the same mechanism.** F002's chip-drag-to-reshare uses HTML5 DnD. `dragDropEnabled` was deliberately left at its default, so chip behaviour is *unchanged* from F002 rather than newly at risk — but confirm it still works (manual check 4), since that is the assumption doing the work.
- ~~**Drop coordinates.**~~ *Resolved:* `windowPointToFlowPosition` does the physical→logical→flow conversion and is unit-tested, including the device-pixel-ratio divide and a round-trip against `flowNodeToWindowBounds`. Still worth eyeballing on a real HiDPI screen (manual check 1).
- **Live reads are unbounded by content addressing.** Every other resource is immutable; a file node is not. Anything that assumed `ResourceRef.path` points under `~/.flowmie/resources/` (e.g. the `opener` capability scope) needs revisiting.
- **A file node points anywhere the user pointed it.** That is intended — the user chose the path — but it means the blast radius of a wire is now "one arbitrary path on disk," and for a folder node, a subtree. The traversal guard is what keeps it *only* that.
