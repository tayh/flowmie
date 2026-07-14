use serde::Serialize;
use tauri::{AppHandle, State};

use crate::pty::manager::PtyManager;
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
    agent_type: String,
    cwd: String,
    role: Option<String>,
) -> Result<PtySpawnResult, String> {
    let pty_id = manager.spawn(app, &agent_type, &cwd, role)?;
    Ok(PtySpawnResult { pty_id })
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, pty_id: String, data: String) -> Result<(), String> {
    manager.write(&pty_id, &data)
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
