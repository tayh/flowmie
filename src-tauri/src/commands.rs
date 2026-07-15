use serde::Serialize;
use tauri::{AppHandle, State};

use crate::pty::manager::PtyManager;
use crate::skills::bridge::SkillsState;
use crate::skills::Snapshot;
use crate::webview::manager as webview_manager;
use crate::workspace::{persistence, Workspace, WorkspaceSummary};

#[derive(Serialize)]
pub struct PtySpawnResult {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    skills: State<'_, SkillsState>,
    agent_type: String,
    cwd: String,
    role: Option<String>,
    node_id: Option<String>,
    skills_enabled: Option<bool>,
) -> Result<PtySpawnResult, String> {
    // Wire the agent to the skills bridge when enabled and we know both the
    // node's id (to identify it) and the bridge's URL (it's listening).
    let skills_spawn = match (skills_enabled.unwrap_or(false), node_id, skills.bridge_url()) {
        (true, Some(node_id), Some(bridge_url)) => Some(crate::skills::SkillsSpawn {
            node_id,
            bridge_url,
            token: skills.token().to_string(),
        }),
        _ => None,
    };
    let pty_id = manager.spawn(app, &agent_type, &cwd, role, skills_spawn)?;
    Ok(PtySpawnResult { pty_id })
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, pty_id: String, data: String) -> Result<(), String> {
    manager.write(&pty_id, &data)
}

/// Submit a relayed/sent message to a terminal's input, framed for its agent
/// type (bracketed paste for TUIs so nothing is dropped). Used by the relay
/// (`useRelay`) and shares the exact delivery path as `send_message`.
#[tauri::command]
pub fn pty_submit(
    manager: State<'_, PtyManager>,
    pty_id: String,
    text: String,
    agent_type: String,
) -> Result<(), String> {
    manager.submit_message(&pty_id, &text, &agent_type)
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, pty_id: String) -> Result<(), String> {
    manager.kill(&pty_id)
}

#[tauri::command]
pub fn workspace_save(workspace: Workspace) -> Result<(), String> {
    persistence::save(&workspace)
}

#[tauri::command]
pub fn workspace_load(workspace_id: String) -> Result<Workspace, String> {
    persistence::load(&workspace_id)
}

#[tauri::command]
pub fn workspace_list() -> Result<Vec<WorkspaceSummary>, String> {
    persistence::list()
}

#[derive(Serialize)]
pub struct WebviewCreateResult {
    #[serde(rename = "webviewLabel")]
    pub webview_label: String,
}

// Async so these never run on the GTK main thread themselves — the manager
// blocks briefly on a channel round-trip to run_on_main_thread, and calling
// that from the main thread would deadlock.
#[tauri::command]
pub async fn webview_create(
    app: AppHandle,
    node_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<WebviewCreateResult, String> {
    let label = format!("webview-{node_id}");
    webview_manager::create(&app, &label, &url, x, y, width, height)?;
    Ok(WebviewCreateResult {
        webview_label: label,
    })
}

#[tauri::command]
pub async fn webview_update_bounds(
    app: AppHandle,
    webview_label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    webview_manager::update_bounds(&app, &webview_label, x, y, width, height)
}

#[tauri::command]
pub async fn webview_destroy(app: AppHandle, webview_label: String) -> Result<(), String> {
    webview_manager::destroy(&app, &webview_label)
}

/// Push the current canvas topology to the skills bridge so agents' skill
/// calls see a live view of who's on the canvas and how they're wired.
#[tauri::command]
pub fn skills_sync_topology(skills: State<'_, SkillsState>, snapshot: Snapshot) -> Result<(), String> {
    skills.update(snapshot);
    Ok(())
}

#[derive(Serialize)]
pub struct SkillsBridgeInfo {
    pub url: Option<String>,
    pub token: String,
}

/// Where the bridge is listening and the token agents must present. Used by
/// the frontend for diagnostics; spawn wiring reads the same state directly.
#[tauri::command]
pub fn skills_bridge_info(skills: State<'_, SkillsState>) -> SkillsBridgeInfo {
    SkillsBridgeInfo {
        url: skills.bridge_url(),
        token: skills.token().to_string(),
    }
}

