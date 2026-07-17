use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::events::ResourceCreatedEvent;
use crate::pty::manager::PtyManager;
use crate::resources::{decode_base64, ReadResult, ResourceRef, ResourceStore};
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

// --- Resources (F002 Phase 3) ---------------------------------------------

/// Store a blob (from base64 or an existing file path) as a content-addressed
/// resource. Used by the frontend for user-dropped images and drag-to-reshare.
/// The caller receives the ref and adds it to the workspace store, so this does
/// not emit `resource://created` (the bridge path, which the frontend can't
/// otherwise observe, does).
#[tauri::command]
pub fn resource_register(
    store: State<'_, ResourceStore>,
    kind: String,
    mime: String,
    label: String,
    owner_node_id: Option<String>,
    data_base64: Option<String>,
    src_path: Option<String>,
) -> Result<ResourceRef, String> {
    match (data_base64, src_path) {
        (Some(data), _) => {
            let bytes = decode_base64(&data)?;
            store.register_bytes(&kind, &mime, &label, owner_node_id, &bytes)
        }
        (None, Some(path)) => store.register_from_path(&kind, &mime, &label, owner_node_id, &path),
        (None, None) => Err("resource_register needs dataBase64 or srcPath".to_string()),
    }
}

/// Materialize a resource by id, as a path or inline content. Backs both the
/// `get_resource` skill and any UI that opens a resource.
#[tauri::command]
pub fn resource_read(
    store: State<'_, ResourceStore>,
    resource_id: String,
    r#as: Option<String>,
) -> Result<ReadResult, String> {
    store.read(&resource_id, r#as.as_deref().unwrap_or("path"))
}

/// Seed the store from a workspace's persisted refs on load, so resources
/// shared in a previous session stay readable by agents. Idempotent by id.
#[tauri::command]
pub fn resources_sync(
    store: State<'_, ResourceStore>,
    resources: Vec<ResourceRef>,
) -> Result<(), String> {
    for resource in resources {
        store.insert_existing(resource);
    }
    Ok(())
}

/// Screenshot a webview node to an image resource (UI-initiated). Owned by the
/// webview node so the shot appears in that Portal's tray. Shares the capture
/// path with the `capture_webview` skill.
#[tauri::command]
pub async fn webview_capture(
    app: AppHandle,
    node_id: String,
    webview_label: String,
    label: String,
) -> Result<ResourceRef, String> {
    // Run the (blocking) capture off the async command task's thread pool
    // worker; `capture` blocks on the snapshot callback and must not sit on the
    // GTK main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<ResourceStore>();
        capture_webview_resource(&app, &store, &webview_label, Some(node_id), &label)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shared capture → register → emit path used by the `webview_capture` command
/// and the `capture_webview` skill. Screenshots `webview_label`, stores it as a
/// PNG resource owned by `owner`, emits `resource://created`, returns the ref.
pub fn capture_webview_resource(
    app: &AppHandle,
    store: &ResourceStore,
    webview_label: &str,
    owner: Option<String>,
    label: &str,
) -> Result<ResourceRef, String> {
    let png = webview_manager::capture(app, webview_label)?;
    let resource = store.register_bytes("image", "image/png", label, owner, &png)?;
    let _ = app.emit(
        "resource://created",
        ResourceCreatedEvent {
            resource: resource.clone(),
        },
    );
    Ok(resource)
}

