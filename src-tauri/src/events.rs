use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct PtyDataEvent {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyExitEvent {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
}

#[derive(Clone, Serialize)]
pub struct PtyErrorEvent {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
pub struct WebviewLoadedEvent {
    #[serde(rename = "webviewLabel")]
    pub webview_label: String,
}

/// Emitted when one agent delivers a directed message to another (F002
/// Phase 2). Drives the canvas edge animation.
#[derive(Clone, Serialize)]
pub struct SkillMessageEvent {
    #[serde(rename = "fromNodeId")]
    pub from_node_id: String,
    #[serde(rename = "toNodeId")]
    pub to_node_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
}

/// Emitted when a resource is registered by an agent skill (`share_resource`,
/// `capture_webview`) so the frontend can add it to the workspace for
/// persistence and the resource tray (F002 Phase 3). Carries the full ref so
/// the frontend needn't round-trip to fetch it.
#[derive(Clone, Serialize)]
pub struct ResourceCreatedEvent {
    pub resource: crate::resources::ResourceRef,
}
