//! Agent skills (F002 Phase 1): a small localhost bridge that answers an
//! agent's questions about the canvas it lives on.
//!
//! The canvas graph is owned by the frontend (Zustand `useWorkspace`), so the
//! frontend pushes a compact snapshot here via `skills_sync_topology` whenever
//! it changes. Each spawned coding agent is configured with an MCP server (the
//! Node shim in `mcp-server/flowmie-mcp.mjs`) whose tools call this bridge over
//! HTTP, identifying themselves with the node id baked into their MCP config.
//!
//! The permission model is deliberately the same one users already see on the
//! canvas: an agent may see/reach a peer only through an **enabled** edge
//! (F001), respecting the edge's direction. The pure functions below encode
//! that and are unit-tested.

pub mod bridge;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Everything an agent needs to reach the bridge, resolved at spawn time.
#[derive(Debug, Clone)]
pub struct SkillsSpawn {
    pub node_id: String,
    pub bridge_url: String,
    pub token: String,
}

/// Absolute path to the Node MCP shim. Overridable via `FLOWMIE_MCP_SHIM`
/// (used by tests/packaging); defaults to the copy in the repo next to
/// `src-tauri`, which is correct for `tauri dev`.
pub fn shim_path() -> String {
    if let Ok(p) = std::env::var("FLOWMIE_MCP_SHIM") {
        return p;
    }
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // src-tauri -> repo root
    path.push("mcp-server");
    path.push("flowmie-mcp.mjs");
    path.to_string_lossy().into_owned()
}

/// What a skills-enabled agent is told about its situation at spawn, appended
/// to its system prompt so it costs no turn and never appears in the terminal.
///
/// Deliberately does **not** list the agent's peers: the canvas is live, and a
/// roster baked in here would be wrong the moment a wire is drawn or cut. It
/// says *that* peers may exist and how to look them up, so the agent's picture
/// is always fetched fresh rather than remembered stale.
///
/// This describes the agent's *situation*; the MCP server's `instructions`
/// (mcp-server/flowmie-mcp.mjs) describes the *tools*. They overlap on purpose
/// — an agent whose client drops one still gets the other — so keep them
/// consistent when editing either.
pub fn canvas_preamble(node_id: &str, role: Option<&str>) -> String {
    let mut s = String::from(
        "You are running inside Flowmie, as a terminal node on the user's canvas. \
         You are not alone: the canvas may hold other agents, notes, embedded browsers \
         (Portals), and files, and the user wires nodes together with edges.\n\n\
         An edge is a permission. You can see, message, and read from another node only \
         if an enabled edge connects you to it — so if something is not wired to you, it \
         is not available to you, and that is intentional rather than an error.\n\n\
         You have Flowmie skills available as tools (named `mcp__flowmie__*` if your \
         client prefixes them). Use them on your own initiative:\n\
         - `whoami` — your own identity on the canvas.\n\
         - `list_agents` / `get_connections` — who is wired to you, right now. The canvas \
         changes while you run, so call these when it matters rather than assuming.\n\
         - `send_message` / `reply` / `wait_for_reply` — talk to a connected peer. Use \
         `reply` to answer whoever just messaged you; it needs no node id.\n\
         - `list_resources` / `get_resource` — read what is wired to you: a note's text, a \
         file or folder pinned to the canvas, an image a peer shared.\n\
         - `capture_webview` / `share_resource` — screenshot a connected Portal; publish \
         something for connected peers to fetch.\n\n\
         If a peer messages you, answering is expected — you are part of a workspace, not \
         a solo session.\n",
    );
    s.push_str(&format!("\nYour node id is {node_id}."));
    if let Some(role) = role.map(str::trim).filter(|r| !r.is_empty()) {
        s.push_str(&format!(" Your role on this canvas: {role}"));
    }
    s
}

/// Write the per-node MCP config Claude Code will load with `--mcp-config`.
/// The node id, bridge URL, and token are baked into the server's `env` so
/// the shim knows which node is asking without relying on env inheritance.
/// Returns the config file path.
pub fn write_mcp_config(spawn: &SkillsSpawn) -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or("no home directory")?
        .join(".flowmie")
        .join("mcp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let config = serde_json::json!({
        "mcpServers": {
            "flowmie": {
                "command": "node",
                "args": [shim_path()],
                "env": {
                    "FLOWMIE_NODE_ID": spawn.node_id,
                    "FLOWMIE_BRIDGE_URL": spawn.bridge_url,
                    "FLOWMIE_BRIDGE_TOKEN": spawn.token,
                }
            }
        }
    });

    let path = dir.join(format!("{}.json", spawn.node_id));
    std::fs::write(&path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// One terminal agent as the frontend sees it. Mirrors the compact payload
/// sent by `skills_sync_topology`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalInfo {
    pub id: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub cwd: String,
    /// Runtime PTY id; `None` when the terminal is disconnected. Used by
    /// Phase 2 messaging to address a peer's input.
    #[serde(rename = "ptyId", default)]
    pub pty_id: Option<String>,
}

impl TerminalInfo {
    /// Human/agent-facing name: the role if set, otherwise the agent type.
    pub fn label(&self) -> String {
        match &self.role {
            Some(r) if !r.trim().is_empty() => r.clone(),
            _ => self.agent_type.clone(),
        }
    }
}

/// A relay edge, mirroring F001's `CanvasEdge` (the subset the bridge needs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EdgeInfo {
    pub source: String,
    pub target: String,
    /// `"source-to-target"` or `"bidirectional"`.
    pub direction: String,
    pub enabled: bool,
}

/// A webview (Portal) node the bridge needs to resolve for `capture_webview`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebviewInfo {
    pub id: String,
    #[serde(rename = "webviewLabel", default)]
    pub webview_label: Option<String>,
    #[serde(default)]
    pub label: String,
}

/// A note the bridge surfaces to a connected agent as a text resource (F002
/// Phase 3). `connected_terminal_id` is the terminal the note is wired to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteInfo {
    pub id: String,
    #[serde(default)]
    pub content: String,
    #[serde(rename = "connectedTerminalId", default)]
    pub connected_terminal_id: Option<String>,
}

/// A file node (F003) the bridge surfaces to agents wired to it. Holds a live
/// path — the bytes are read from disk at call time, never copied into the
/// resource store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileInfo {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "isDirectory", default)]
    pub is_directory: bool,
}

/// The current canvas topology as far as the bridge is concerned.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub terminals: Vec<TerminalInfo>,
    #[serde(default)]
    pub edges: Vec<EdgeInfo>,
    #[serde(default)]
    pub webviews: Vec<WebviewInfo>,
    #[serde(default)]
    pub notes: Vec<NoteInfo>,
    #[serde(default)]
    pub files: Vec<FileInfo>,
}

/// The caller's own identity (`whoami`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WhoAmI {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    pub role: Option<String>,
    pub cwd: String,
    pub label: String,
}

/// A peer agent as reported to the caller (`list_agents`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentInfo {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    pub role: Option<String>,
    pub label: String,
    /// Whether an enabled edge connects the caller and this peer at all.
    pub connected: bool,
    /// The caller may deliver a message to this peer (Phase 2).
    #[serde(rename = "canSend")]
    pub can_send: bool,
    /// This peer's responses can reach the caller.
    #[serde(rename = "canReceive")]
    pub can_receive: bool,
}

/// One edge from the caller's point of view (`get_connections`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Connection {
    #[serde(rename = "peerNodeId")]
    pub peer_node_id: String,
    /// `"outgoing"`, `"incoming"`, or `"bidirectional"` relative to the caller.
    pub direction: String,
    pub enabled: bool,
}

/// Does an enabled edge between `a` and `b` permit `a → b` data flow?
/// A `source-to-target` edge only flows from its source; a `bidirectional`
/// edge flows both ways.
fn edge_allows(edge: &EdgeInfo, from: &str, to: &str) -> bool {
    if !edge.enabled {
        return false;
    }
    let touches = (edge.source == from && edge.target == to)
        || (edge.source == to && edge.target == from);
    if !touches {
        return false;
    }
    edge.source == from || edge.direction == "bidirectional"
}

/// The caller can send to `peer` if any enabled edge permits caller → peer.
pub fn can_send(snapshot: &Snapshot, caller: &str, peer: &str) -> bool {
    snapshot.edges.iter().any(|e| edge_allows(e, caller, peer))
}

/// The caller can receive from `peer` if any enabled edge permits peer → caller.
pub fn can_receive(snapshot: &Snapshot, caller: &str, peer: &str) -> bool {
    snapshot.edges.iter().any(|e| edge_allows(e, peer, caller))
}

/// Whether any enabled edge connects `a` and `b`, ignoring direction. Used for
/// capturing a webview (Portal), which is a passive node — a wire in either
/// orientation authorizes an agent to screenshot it.
pub fn can_reach(snapshot: &Snapshot, a: &str, b: &str) -> bool {
    snapshot
        .edges
        .iter()
        .any(|e| e.enabled && ((e.source == a && e.target == b) || (e.source == b && e.target == a)))
}

/// Whether `caller` may read a resource owned by `owner`. You can always read
/// your own; otherwise you need an enabled edge that lets the owner's data
/// reach you (`owner → caller`), mirroring how a peer's reply reaches you.
///
/// An **unowned** resource (`owner == None`) is readable by **no one** (F003).
/// It used to be readable by everyone, which was the one hole in "the edge
/// graph is the permission graph" — an ownerless resource has no node, so it
/// has no edges, so there is nothing on the canvas a user could point at to
/// explain why an agent could read it. Files now arrive as file nodes, which
/// have an owner and therefore an answer.
pub fn can_access_resource(snapshot: &Snapshot, caller: &str, owner: Option<&str>) -> bool {
    match owner {
        None => false,
        Some(o) if o == caller => true,
        Some(o) => can_receive(snapshot, caller, o),
    }
}

/// Collapse an agent-authored message into a single submittable line: control
/// characters (newlines, tabs, CR, ANSI) become spaces so the whole text is
/// submitted as one input rather than firing on an embedded newline.
pub fn sanitize_message(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn whoami(snapshot: &Snapshot, caller: &str) -> Option<WhoAmI> {
    let t = snapshot.terminals.iter().find(|t| t.id == caller)?;
    Some(WhoAmI {
        node_id: t.id.clone(),
        agent_type: t.agent_type.clone(),
        role: t.role.clone(),
        cwd: t.cwd.clone(),
        label: t.label(),
    })
}

/// Every terminal agent on the canvas (excluding the caller). With
/// `connected_only`, keep only peers reachable by an enabled edge.
pub fn agents_for(snapshot: &Snapshot, caller: &str, connected_only: bool) -> Vec<AgentInfo> {
    snapshot
        .terminals
        .iter()
        .filter(|t| t.id != caller)
        .filter_map(|t| {
            let send = can_send(snapshot, caller, &t.id);
            let recv = can_receive(snapshot, caller, &t.id);
            let connected = send || recv;
            if connected_only && !connected {
                return None;
            }
            Some(AgentInfo {
                node_id: t.id.clone(),
                agent_type: t.agent_type.clone(),
                role: t.role.clone(),
                label: t.label(),
                connected,
                can_send: send,
                can_receive: recv,
            })
        })
        .collect()
}

/// The caller's connections: one entry per peer it shares an enabled edge with.
pub fn connections_for(snapshot: &Snapshot, caller: &str) -> Vec<Connection> {
    snapshot
        .terminals
        .iter()
        .filter(|t| t.id != caller)
        .filter_map(|t| {
            let send = can_send(snapshot, caller, &t.id);
            let recv = can_receive(snapshot, caller, &t.id);
            if !send && !recv {
                return None;
            }
            let direction = match (send, recv) {
                (true, true) => "bidirectional",
                (true, false) => "outgoing",
                (false, true) => "incoming",
                (false, false) => unreachable!(),
            };
            Some(Connection {
                peer_node_id: t.id.clone(),
                direction: direction.to_string(),
                enabled: true,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(id: &str, agent: &str, role: Option<&str>) -> TerminalInfo {
        TerminalInfo {
            id: id.to_string(),
            agent_type: agent.to_string(),
            role: role.map(|r| r.to_string()),
            cwd: "/tmp".to_string(),
            pty_id: Some(format!("pty-{id}")),
        }
    }

    fn edge(source: &str, target: &str, direction: &str, enabled: bool) -> EdgeInfo {
        EdgeInfo {
            source: source.to_string(),
            target: target.to_string(),
            direction: direction.to_string(),
            enabled,
        }
    }

    fn snap(terminals: Vec<TerminalInfo>, edges: Vec<EdgeInfo>) -> Snapshot {
        Snapshot {
            terminals,
            edges,
            ..Default::default()
        }
    }

    #[test]
    fn whoami_uses_role_as_label_and_falls_back_to_agent_type() {
        let s = snap(
            vec![term("a", "claude", Some("Bug Whisperer")), term("b", "codex", None)],
            vec![],
        );
        assert_eq!(whoami(&s, "a").unwrap().label, "Bug Whisperer");
        assert_eq!(whoami(&s, "b").unwrap().label, "codex");
        assert!(whoami(&s, "missing").is_none());
    }

    #[test]
    fn source_to_target_edge_is_one_directional() {
        let s = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "source-to-target", true)],
        );
        // a can send to b but not receive; b is the mirror.
        let a_view = &agents_for(&s, "a", true)[0];
        assert!(a_view.can_send && !a_view.can_receive && a_view.connected);
        let b_view = &agents_for(&s, "b", true)[0];
        assert!(!b_view.can_send && b_view.can_receive);

        assert_eq!(connections_for(&s, "a")[0].direction, "outgoing");
        assert_eq!(connections_for(&s, "b")[0].direction, "incoming");
    }

    #[test]
    fn bidirectional_edge_allows_both_ways() {
        let s = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "bidirectional", true)],
        );
        let a_view = &agents_for(&s, "a", true)[0];
        assert!(a_view.can_send && a_view.can_receive);
        assert_eq!(connections_for(&s, "a")[0].direction, "bidirectional");
    }

    #[test]
    fn disabled_edge_severs_the_connection() {
        let s = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "bidirectional", false)],
        );
        assert!(agents_for(&s, "a", true).is_empty());
        assert!(connections_for(&s, "a").is_empty());
        // Still visible when not filtering to connected peers.
        let all = agents_for(&s, "a", false);
        assert_eq!(all.len(), 1);
        assert!(!all[0].connected);
    }

    #[test]
    fn unrelated_peers_are_not_connected() {
        let s = snap(
            vec![
                term("a", "claude", None),
                term("b", "claude", None),
                term("c", "claude", None),
            ],
            vec![edge("a", "b", "source-to-target", true)],
        );
        // From c's view, a and b exist but neither is connected.
        assert!(agents_for(&s, "c", true).is_empty());
        assert_eq!(agents_for(&s, "c", false).len(), 2);
    }

    #[test]
    fn send_and_receive_respect_direction() {
        let s = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "source-to-target", true)],
        );
        assert!(can_send(&s, "a", "b"));
        assert!(!can_receive(&s, "a", "b"));
        assert!(can_receive(&s, "b", "a"));
        assert!(!can_send(&s, "b", "a"));
    }

    #[test]
    fn can_reach_is_direction_agnostic_but_needs_enabled() {
        let s = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "source-to-target", true)],
        );
        assert!(can_reach(&s, "a", "b"));
        assert!(can_reach(&s, "b", "a"));
        let off = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "source-to-target", false)],
        );
        assert!(!can_reach(&off, "a", "b"));
    }

    #[test]
    fn resource_access_follows_ownership_and_edges() {
        // a -> b only: b can receive a's data, a cannot receive b's.
        let s = snap(
            vec![term("a", "claude", None), term("b", "claude", None)],
            vec![edge("a", "b", "source-to-target", true)],
        );
        // Owner reads own.
        assert!(can_access_resource(&s, "a", Some("a")));
        // An unowned resource is readable by no one (F003): with no owner node
        // there is no edge, and the edge is the whole grant.
        assert!(!can_access_resource(&s, "b", None));
        // b may read a's resource (a -> b); a may not read b's.
        assert!(can_access_resource(&s, "b", Some("a")));
        assert!(!can_access_resource(&s, "a", Some("b")));
    }

    #[test]
    fn canvas_preamble_states_identity_and_how_to_look_around() {
        let p = canvas_preamble("node-1", Some("Code Reviewer"));
        assert!(p.contains("Flowmie"));
        assert!(p.contains("node-1"));
        assert!(p.contains("Code Reviewer"));
        // The two load-bearing facts: peers exist, and the edge is the grant.
        assert!(p.contains("list_agents"));
        assert!(p.contains("An edge is a permission"));
    }

    #[test]
    fn canvas_preamble_bakes_in_no_peer_roster() {
        // A roster would be stale the moment a wire changes; the agent is told
        // to look instead. Guards against someone "helpfully" adding one.
        let p = canvas_preamble("node-1", None);
        assert!(p.contains("call these when it matters"));
        assert!(!p.contains("Connected peers"));
    }

    #[test]
    fn canvas_preamble_omits_an_absent_or_blank_role() {
        assert!(!canvas_preamble("node-1", None).contains("Your role"));
        // A role of whitespace is no role — don't emit a dangling label.
        assert!(!canvas_preamble("node-1", Some("   ")).contains("Your role"));
    }

    #[test]
    fn sanitize_message_collapses_control_chars() {
        assert_eq!(sanitize_message("  hello\nworld\t!  "), "hello world !");
        assert_eq!(sanitize_message("x\r\ny"), "x  y");
        assert_eq!(sanitize_message("\n\n  \t"), "");
    }
}
