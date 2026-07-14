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
