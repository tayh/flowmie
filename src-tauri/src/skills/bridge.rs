//! The localhost HTTP bridge the MCP shim talks to.
//!
//! A tiny blocking server (`tiny_http`) bound to an ephemeral loopback port.
//! Every request must carry the shared token in `X-Flowmie-Token`, which is
//! handed to each agent through its MCP config env — this keeps other local
//! processes from poking the bridge.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server};

use super::{
    agents_for, can_access_resource, can_reach, can_receive, can_send, connections_for,
    sanitize_message, whoami, NoteInfo, Snapshot,
};
use crate::commands::capture_webview_resource;
use crate::events::{ResourceCreatedEvent, SkillMessageEvent};
use crate::pty::manager::PtyManager;
use crate::resources::{decode_base64, ResourceRef, ResourceStore};

/// One directed message an agent explicitly sent to another via `send_message`,
/// tagged with a monotonic sequence number. `wait_for_reply` scans this log for
/// "a message from the peer I messaged, back to me, after my message" — so
/// replies are the peer's exact words, never scraped from its terminal screen.
#[derive(Clone)]
struct MessageRecord {
    seq: u64,
    from: String,
    to: String,
    text: String,
}

/// Keep the message log bounded — only recent history matters to a waiter.
const MAX_MESSAGES: usize = 200;

type MessageLog = Vec<MessageRecord>;

/// Tauri-managed state shared between commands and the bridge thread.
pub struct SkillsState {
    snapshot: Arc<Mutex<Snapshot>>,
    messages: Arc<Mutex<MessageLog>>,
    seq: Arc<AtomicU64>,
    token: String,
    port: Mutex<Option<u16>>,
}

impl SkillsState {
    pub fn new() -> Self {
        Self {
            snapshot: Arc::new(Mutex::new(Snapshot::default())),
            messages: Arc::new(Mutex::new(Vec::new())),
            seq: Arc::new(AtomicU64::new(0)),
            token: uuid::Uuid::new_v4().to_string(),
            port: Mutex::new(None),
        }
    }

    /// Replace the cached topology (called by `skills_sync_topology`).
    pub fn update(&self, snapshot: Snapshot) {
        *self.snapshot.lock().unwrap() = snapshot;
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn port(&self) -> Option<u16> {
        *self.port.lock().unwrap()
    }

    /// `http://127.0.0.1:<port>` once the bridge is listening.
    pub fn bridge_url(&self) -> Option<String> {
        self.port().map(|p| format!("http://127.0.0.1:{p}"))
    }
}

impl Default for SkillsState {
    fn default() -> Self {
        Self::new()
    }
}

/// Append a directed message to the log and return its sequence number.
fn record_message(
    messages: &Arc<Mutex<MessageLog>>,
    seq: &Arc<AtomicU64>,
    from: &str,
    to: &str,
    text: &str,
) -> u64 {
    let s = seq.fetch_add(1, Ordering::SeqCst) + 1;
    let mut log = messages.lock().unwrap();
    log.push(MessageRecord {
        seq: s,
        from: from.to_string(),
        to: to.to_string(),
        text: text.to_string(),
    });
    let overflow = log.len().saturating_sub(MAX_MESSAGES);
    if overflow > 0 {
        log.drain(0..overflow);
    }
    s
}

/// Shared handles the request handlers need, cloned into the server thread.
#[derive(Clone)]
struct Handlers {
    app: AppHandle,
    snapshot: Arc<Mutex<Snapshot>>,
    messages: Arc<Mutex<MessageLog>>,
    seq: Arc<AtomicU64>,
}

#[derive(Deserialize)]
struct MessageBody {
    #[serde(rename = "toNodeId")]
    to_node_id: String,
    text: String,
}

#[derive(Deserialize)]
struct ReplyBody {
    text: String,
}

#[derive(Deserialize)]
struct ShareBody {
    kind: String,
    mime: String,
    label: String,
    #[serde(rename = "dataBase64", default)]
    data_base64: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct CaptureBody {
    #[serde(rename = "nodeId")]
    node_id: String,
}

/// Build the synthetic text `ResourceRef` a connected note is surfaced as. Its
/// id is `note:<noteId>`; it has no on-disk blob — `get_resource` returns the
/// note's live text inline.
fn note_resource(note: &NoteInfo) -> ResourceRef {
    ResourceRef {
        id: format!("note:{}", note.id),
        kind: "text".to_string(),
        mime: "text/markdown".to_string(),
        label: "note".to_string(),
        owner_node_id: note.connected_terminal_id.clone(),
        created_at: String::new(),
        path: String::new(),
    }
}

fn json_response(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Percent-decode a query component (`%40` → `@`). The shim URL-encodes tool
/// arguments, so e.g. a `<nodeId>@<seq>` messageId arrives with the `@` as
/// `%40`; without this the `@` split in `handle_reply` never matches.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse and percent-decode the `?a=b&c=d` portion of a request URL.
fn query_pairs(url: &str) -> Vec<(String, String)> {
    let Some((_, query)) = url.split_once('?') else {
        return Vec::new();
    };
    query
        .split('&')
        .filter_map(|kv| {
            kv.split_once('=')
                .map(|(k, v)| (percent_decode(k), percent_decode(v)))
        })
        .collect()
}

fn query_get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn path_of(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

/// Deliver `text` from `caller` to `to_node_id`'s input, recording it and
/// returning `{delivered, toNodeId, messageId}`. Shared by `send_message` and
/// `reply`.
fn deliver(h: &Handlers, caller: &str, to_node_id: &str, text: &str) -> (u16, String) {
    let (pty_id, agent_type, sender_label) = {
        let snap = h.snapshot.lock().unwrap();
        if !can_send(&snap, caller, to_node_id) {
            return (
                403,
                "{\"error\":\"not connected: you have no enabled outgoing connection to that agent\"}"
                    .into(),
            );
        }
        // How the sender is labelled to the recipient (role, else agent type).
        let sender_label = snap
            .terminals
            .iter()
            .find(|t| t.id == caller)
            .map(|t| t.label())
            .unwrap_or_else(|| "an agent".to_string());
        let Some(target) = snap.terminals.iter().find(|t| t.id == to_node_id) else {
            return (404, "{\"error\":\"unknown target agent\"}".into());
        };
        match &target.pty_id {
            Some(id) => (id.clone(), target.agent_type.clone(), sender_label),
            None => {
                return (
                    409,
                    "{\"error\":\"that agent has no running terminal\"}".into(),
                )
            }
        }
    };

    // Record the message first so its sequence becomes the reply watermark:
    // a reply the peer sends back necessarily gets a higher sequence.
    let watermark = record_message(&h.messages, &h.seq, caller, to_node_id, text);
    let message_id = format!("{to_node_id}@{watermark}");

    // Frame the delivered text so the recipient knows who it's from and how to
    // answer through the clean skill channel — replying needs no node id, which
    // agents fumble; the `reply` skill routes back to the most recent sender.
    let framed = format!(
        "[flowmie] Message from {sender_label} (agent {caller}). \
         To answer, call the flowmie `reply` skill with your message text — no id needed. \
         Message: {text}"
    );

    // Deliver via the agent-aware submit path (bracketed paste for TUIs).
    let manager = h.app.state::<PtyManager>();
    if let Err(e) = manager.submit_message(&pty_id, &framed, &agent_type) {
        return (500, format!("{{\"error\":\"write failed: {e}\"}}"));
    }

    let _ = h.app.emit(
        "skill://message",
        SkillMessageEvent {
            from_node_id: caller.to_string(),
            to_node_id: to_node_id.to_string(),
            message_id: message_id.clone(),
        },
    );

    (
        200,
        format!("{{\"delivered\":true,\"toNodeId\":\"{to_node_id}\",\"messageId\":\"{message_id}\"}}"),
    )
}

/// `send_message`: deliver to an explicitly-named peer.
fn handle_message(h: &Handlers, caller: &str, body: &str) -> (u16, String) {
    let parsed: MessageBody = match serde_json::from_str(body) {
        Ok(b) => b,
        Err(e) => return (400, format!("{{\"error\":\"bad body: {e}\"}}")),
    };
    let text = sanitize_message(&parsed.text);
    if text.is_empty() {
        return (400, "{\"error\":\"empty message\"}".into());
    }
    deliver(h, caller, &parsed.to_node_id, &text)
}

/// `reply`: answer the agent who most recently messaged the caller, without
/// needing its node id (which peers reach for and get wrong).
fn handle_reply_send(h: &Handlers, caller: &str, body: &str) -> (u16, String) {
    let parsed: ReplyBody = match serde_json::from_str(body) {
        Ok(b) => b,
        Err(e) => return (400, format!("{{\"error\":\"bad body: {e}\"}}")),
    };
    let text = sanitize_message(&parsed.text);
    if text.is_empty() {
        return (400, "{\"error\":\"empty message\"}".into());
    }
    match last_sender_to(&h.messages, caller) {
        Some(target) => deliver(h, caller, &target, &text),
        None => (
            409,
            "{\"error\":\"no message to reply to — no agent has messaged you\"}".into(),
        ),
    }
}

/// The node that most recently messaged `caller` (the `reply` target).
fn last_sender_to(messages: &Arc<Mutex<MessageLog>>, caller: &str) -> Option<String> {
    messages
        .lock()
        .unwrap()
        .iter()
        .filter(|m| m.to == caller)
        .max_by_key(|m| m.seq)
        .map(|m| m.from.clone())
}

/// Block (polling) until the messaged peer sends a message back to the caller
/// (via its own `send_message`), or the timeout elapses. Resolves with the
/// peer's exact text — never scraped screen output. Runs on its own thread so
/// it never stalls the server loop. Takes the shared state directly (no
/// `AppHandle`) so it's unit-testable.
fn handle_reply(
    snapshot: &Arc<Mutex<Snapshot>>,
    messages: &Arc<Mutex<MessageLog>>,
    caller: &str,
    since: &str,
    timeout_ms: u64,
) -> (u16, String) {
    let Some((target, watermark)) = since.split_once('@') else {
        return (400, "{\"error\":\"bad sinceMessageId\"}".into());
    };
    let watermark: u64 = match watermark.parse() {
        Ok(w) => w,
        Err(_) => return (400, "{\"error\":\"bad sinceMessageId\"}".into()),
    };

    {
        let snap = snapshot.lock().unwrap();
        if !can_receive(&snap, caller, target) {
            return (
                403,
                "{\"error\":\"not connected: you have no enabled connection to receive that agent's reply\"}"
                    .into(),
            );
        }
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        // The earliest message from the target back to us after our message.
        let reply = messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.from == target && m.to == caller && m.seq > watermark)
            .min_by_key(|m| m.seq)
            .map(|m| m.text.clone());
        if let Some(text) = reply {
            let payload = serde_json::json!({ "text": text, "fromNodeId": target });
            return (200, payload.to_string());
        }
        if Instant::now() >= deadline {
            return (200, "{\"timedOut\":true}".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `list_resources`: refs the caller may access (owned + reachable by an
/// enabled edge) plus connected notes surfaced as synthetic text resources.
/// An optional `owner` narrows to one node's resources.
fn handle_list_resources(h: &Handlers, caller: &str, owner: Option<&str>) -> (u16, String) {
    let store = h.app.state::<ResourceStore>();
    let snap = h.snapshot.lock().unwrap();
    let mut refs: Vec<ResourceRef> = store
        .all()
        .into_iter()
        .filter(|r| can_access_resource(&snap, caller, r.owner_node_id.as_deref()))
        .filter(|r| owner.is_none_or(|o| r.owner_node_id.as_deref() == Some(o)))
        .collect();
    // A note is offered to the terminal it is wired to (F002 §4 list_resources).
    for note in &snap.notes {
        if note.connected_terminal_id.as_deref() == Some(caller)
            && owner.is_none_or(|o| o == note.id)
        {
            refs.push(note_resource(note));
        }
    }
    (200, serde_json::to_string(&refs).unwrap())
}

/// `get_resource`: materialize a resource the caller may access. A `note:<id>`
/// id returns the note's live text; otherwise the on-disk blob (path/inline).
fn handle_get_resource(h: &Handlers, caller: &str, id: &str, as_: &str) -> (u16, String) {
    if let Some(note_id) = id.strip_prefix("note:") {
        let snap = h.snapshot.lock().unwrap();
        return match snap.notes.iter().find(|n| n.id == note_id) {
            Some(n) if n.connected_terminal_id.as_deref() == Some(caller) => {
                (200, serde_json::json!({ "content": n.content }).to_string())
            }
            Some(_) => (
                403,
                "{\"error\":\"not connected: that note is not wired to you\"}".into(),
            ),
            None => (404, "{\"error\":\"unknown note\"}".into()),
        };
    }

    let store = h.app.state::<ResourceStore>();
    let Some(resource) = store.get(id) else {
        return (404, "{\"error\":\"unknown resource\"}".into());
    };
    {
        let snap = h.snapshot.lock().unwrap();
        if !can_access_resource(&snap, caller, resource.owner_node_id.as_deref()) {
            return (
                403,
                "{\"error\":\"not connected: you cannot access that resource\"}".into(),
            );
        }
    }
    match store.read(id, as_) {
        Ok(result) => (200, serde_json::to_string(&result).unwrap()),
        Err(e) => (500, format!("{{\"error\":\"{e}\"}}")),
    }
}

/// `share_resource`: publish a blob owned by the caller so connected peers can
/// fetch it. Emits `resource://created` so the canvas records it.
fn handle_share_resource(h: &Handlers, caller: &str, body: &str) -> (u16, String) {
    let parsed: ShareBody = match serde_json::from_str(body) {
        Ok(b) => b,
        Err(e) => return (400, format!("{{\"error\":\"bad body: {e}\"}}")),
    };
    let store = h.app.state::<ResourceStore>();
    let owner = Some(caller.to_string());
    let result = match (parsed.data_base64, parsed.path) {
        (Some(data), _) => match decode_base64(&data) {
            Ok(bytes) => store.register_bytes(&parsed.kind, &parsed.mime, &parsed.label, owner, &bytes),
            Err(e) => Err(e),
        },
        (None, Some(path)) => {
            store.register_from_path(&parsed.kind, &parsed.mime, &parsed.label, owner, &path)
        }
        (None, None) => Err("share_resource needs dataBase64 or path".to_string()),
    };
    match result {
        Ok(resource) => {
            let _ = h.app.emit(
                "resource://created",
                ResourceCreatedEvent {
                    resource: resource.clone(),
                },
            );
            (200, format!("{{\"resourceId\":\"{}\"}}", resource.id))
        }
        Err(e) => (400, format!("{{\"error\":\"{e}\"}}")),
    }
}

/// `capture_webview`: screenshot a connected Portal into an image resource owned
/// by the caller. Blocks on the async WebKit snapshot, so the route dispatch
/// runs it on its own thread.
fn handle_capture(h: &Handlers, caller: &str, body: &str) -> (u16, String) {
    let parsed: CaptureBody = match serde_json::from_str(body) {
        Ok(b) => b,
        Err(e) => return (400, format!("{{\"error\":\"bad body: {e}\"}}")),
    };
    let webview_label = {
        let snap = h.snapshot.lock().unwrap();
        if !can_reach(&snap, caller, &parsed.node_id) {
            return (
                403,
                "{\"error\":\"not connected: draw an edge to that webview to capture it\"}".into(),
            );
        }
        match snap.webviews.iter().find(|w| w.id == parsed.node_id) {
            Some(w) => match &w.webview_label {
                Some(l) => l.clone(),
                None => return (409, "{\"error\":\"that webview is not running\"}".into()),
            },
            None => return (404, "{\"error\":\"unknown webview\"}".into()),
        }
    };
    let label = format!("screenshot of {}", parsed.node_id);
    let store = h.app.state::<ResourceStore>();
    match capture_webview_resource(&h.app, &store, &webview_label, Some(caller.to_string()), &label) {
        Ok(resource) => (
            200,
            format!(
                "{{\"resourceId\":\"{}\",\"path\":{}}}",
                resource.id,
                serde_json::to_string(&resource.path).unwrap()
            ),
        ),
        Err(e) => (500, format!("{{\"error\":\"{e}\"}}")),
    }
}

fn respond(request: Request, status: u16, body: String) {
    let _ = request.respond(json_response(status, body));
}

/// Start the bridge. Binds an ephemeral loopback port, records it in
/// `SkillsState`, and serves requests on a background thread.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SkillsState>();
    let handlers = Handlers {
        app: app.clone(),
        snapshot: state.snapshot.clone(),
        messages: state.messages.clone(),
        seq: state.seq.clone(),
    };
    let token = state.token.clone();

    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|addr| addr.port())
        .ok_or("bridge bound to a non-IP address")?;
    *state.port.lock().unwrap() = Some(port);

    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let authorized = request.headers().iter().any(|hd| {
                hd.field.equiv("X-Flowmie-Token") && hd.value.as_str() == token
            });
            if !authorized {
                respond(request, 401, "{\"error\":\"unauthorized\"}".into());
                continue;
            }

            let url = request.url().to_string();
            let pairs = query_pairs(&url);
            let node = query_get(&pairs, "node").unwrap_or("").to_string();
            let method = request.method().clone();
            let path = path_of(&url).to_string();

            match (&method, path.as_str()) {
                (Method::Get, "/whoami") => {
                    let snap = handlers.snapshot.lock().unwrap();
                    let (s, b) = match whoami(&snap, &node) {
                        Some(w) => (200, serde_json::to_string(&w).unwrap()),
                        None => (404, "{\"error\":\"unknown node\"}".into()),
                    };
                    drop(snap);
                    respond(request, s, b);
                }
                (Method::Get, "/agents") => {
                    let connected_only = query_get(&pairs, "connectedOnly") != Some("false");
                    let snap = handlers.snapshot.lock().unwrap();
                    let agents = agents_for(&snap, &node, connected_only);
                    let body = serde_json::to_string(&agents).unwrap();
                    drop(snap);
                    respond(request, 200, body);
                }
                (Method::Get, "/connections") => {
                    let snap = handlers.snapshot.lock().unwrap();
                    let conns = connections_for(&snap, &node);
                    let body = serde_json::to_string(&conns).unwrap();
                    drop(snap);
                    respond(request, 200, body);
                }
                (Method::Post, "/message") => {
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_err() {
                        respond(request, 400, "{\"error\":\"unreadable body\"}".into());
                        continue;
                    }
                    let (s, b) = handle_message(&handlers, &node, &body);
                    respond(request, s, b);
                }
                (Method::Post, "/reply") => {
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_err() {
                        respond(request, 400, "{\"error\":\"unreadable body\"}".into());
                        continue;
                    }
                    let (s, b) = handle_reply_send(&handlers, &node, &body);
                    respond(request, s, b);
                }
                (Method::Get, "/reply") => {
                    // Long-poll on its own thread so the server keeps serving.
                    let h = handlers.clone();
                    let since = query_get(&pairs, "since").unwrap_or("").to_string();
                    let timeout_ms = query_get(&pairs, "timeoutMs")
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(60_000)
                        .min(300_000);
                    std::thread::spawn(move || {
                        let (s, b) =
                            handle_reply(&h.snapshot, &h.messages, &node, &since, timeout_ms);
                        respond(request, s, b);
                    });
                }
                (Method::Get, "/resources") => {
                    let owner = query_get(&pairs, "owner").map(|s| s.to_string());
                    let (s, b) = handle_list_resources(&handlers, &node, owner.as_deref());
                    respond(request, s, b);
                }
                (Method::Get, "/resource") => {
                    let id = query_get(&pairs, "id").unwrap_or("").to_string();
                    let as_ = query_get(&pairs, "as").unwrap_or("path").to_string();
                    let (s, b) = handle_get_resource(&handlers, &node, &id, &as_);
                    respond(request, s, b);
                }
                (Method::Post, "/resource/share") => {
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_err() {
                        respond(request, 400, "{\"error\":\"unreadable body\"}".into());
                        continue;
                    }
                    let (s, b) = handle_share_resource(&handlers, &node, &body);
                    respond(request, s, b);
                }
                (Method::Post, "/capture") => {
                    // The WebKit snapshot blocks; run it off the server loop.
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_err() {
                        respond(request, 400, "{\"error\":\"unreadable body\"}".into());
                        continue;
                    }
                    let h = handlers.clone();
                    std::thread::spawn(move || {
                        let (s, b) = handle_capture(&h, &node, &body);
                        respond(request, s, b);
                    });
                }
                _ => respond(request, 404, "{\"error\":\"not found\"}".into()),
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{EdgeInfo, Snapshot, TerminalInfo};

    fn state(edges: Vec<EdgeInfo>) -> (Arc<Mutex<Snapshot>>, Arc<Mutex<MessageLog>>, Arc<AtomicU64>) {
        let terminals = vec![
            TerminalInfo {
                id: "a".into(),
                agent_type: "claude".into(),
                role: None,
                cwd: String::new(),
                pty_id: Some("pty-a".into()),
            },
            TerminalInfo {
                id: "b".into(),
                agent_type: "claude".into(),
                role: None,
                cwd: String::new(),
                pty_id: Some("pty-b".into()),
            },
        ];
        (
            Arc::new(Mutex::new(Snapshot {
                terminals,
                edges,
                ..Default::default()
            })),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(AtomicU64::new(0)),
        )
    }

    fn bidi() -> EdgeInfo {
        EdgeInfo {
            source: "a".into(),
            target: "b".into(),
            direction: "bidirectional".into(),
            enabled: true,
        }
    }

    #[test]
    fn reply_resolves_when_the_peer_messages_back() {
        let (snap, messages, seq) = state(vec![bidi()]);
        // A messaged B (seq 1); its id watermark is 1. B replies mid-wait.
        let a_seq = record_message(&messages, &seq, "a", "b", "hello B");
        let (m, s) = (messages.clone(), seq.clone());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            record_message(&m, &s, "b", "a", "the answer");
        });
        let since = format!("b@{a_seq}");
        let (status, body) = handle_reply(&snap, &messages, "a", &since, 3000);
        assert_eq!(status, 200);
        assert!(body.contains("the answer"), "body: {body}");
        assert!(body.contains("\"fromNodeId\":\"b\""));
    }

    #[test]
    fn reply_ignores_messages_that_are_not_the_peers_reply() {
        let (snap, messages, seq) = state(vec![bidi()]);
        let a_seq = record_message(&messages, &seq, "a", "b", "hello B");
        // A message from a→b (not a reply) and an unrelated one must not resolve.
        record_message(&messages, &seq, "a", "b", "another to B");
        let since = format!("b@{a_seq}");
        let (status, body) = handle_reply(&snap, &messages, "a", &since, 150);
        assert_eq!(status, 200);
        assert_eq!(body, "{\"timedOut\":true}");
    }

    #[test]
    fn reply_ignores_the_peers_older_messages() {
        let (snap, messages, seq) = state(vec![bidi()]);
        // A stale reply from B (seq 1) predates A's message (seq 2).
        record_message(&messages, &seq, "b", "a", "stale");
        let a_seq = record_message(&messages, &seq, "a", "b", "hello B");
        let since = format!("b@{a_seq}");
        let (status, body) = handle_reply(&snap, &messages, "a", &since, 150);
        assert_eq!(status, 200);
        assert_eq!(body, "{\"timedOut\":true}");
    }

    #[test]
    fn reply_targets_the_most_recent_sender() {
        let (_snap, messages, seq) = state(vec![bidi()]);
        assert_eq!(last_sender_to(&messages, "b"), None);
        record_message(&messages, &seq, "a", "b", "first");
        record_message(&messages, &seq, "c", "b", "later"); // most recent to b
        record_message(&messages, &seq, "b", "a", "b's own outgoing");
        // Replying as b routes to c (the latest agent that messaged b).
        assert_eq!(last_sender_to(&messages, "b").as_deref(), Some("c"));
        // a's latest inbound is b's message.
        assert_eq!(last_sender_to(&messages, "a").as_deref(), Some("b"));
    }

    #[test]
    fn reply_denied_without_a_receive_path() {
        // a -> b only: a cannot receive b's reply.
        let edge = EdgeInfo {
            source: "a".into(),
            target: "b".into(),
            direction: "source-to-target".into(),
            enabled: true,
        };
        let (snap, messages, _) = state(vec![edge]);
        let (status, _) = handle_reply(&snap, &messages, "a", "b@0", 200);
        assert_eq!(status, 403);
    }

    #[test]
    fn reply_rejects_malformed_since() {
        let (snap, messages, _) = state(vec![bidi()]);
        assert_eq!(handle_reply(&snap, &messages, "a", "garbage", 200).0, 400);
        assert_eq!(handle_reply(&snap, &messages, "a", "b@notnum", 200).0, 400);
    }

    #[test]
    fn query_pairs_percent_decodes_messageid() {
        // The shim sends `since=<uuid>%40<seq>`; we must recover the `@`.
        let pairs = query_pairs("/reply?node=a&since=9961c2d3-b90b%406&timeoutMs=1000");
        assert_eq!(query_get(&pairs, "since"), Some("9961c2d3-b90b@6"));
        assert_eq!(query_get(&pairs, "node"), Some("a"));
        assert_eq!(query_get(&pairs, "timeoutMs"), Some("1000"));
    }

    #[test]
    fn decoded_since_resolves_the_reply() {
        // End-to-end of the decode fix: the decoded `<node>@<seq>` drives the wait.
        let (snap, messages, seq) = state(vec![bidi()]);
        record_message(&messages, &seq, "a", "b", "hi B"); // seq 1
        record_message(&messages, &seq, "b", "a", "hi back"); // seq 2 (the reply)
        let pairs = query_pairs("/reply?node=a&since=b%401");
        let since = query_get(&pairs, "since").unwrap();
        let (status, body) = handle_reply(&snap, &messages, "a", since, 200);
        assert_eq!(status, 200);
        assert!(body.contains("hi back"), "body: {body}");
    }
}
