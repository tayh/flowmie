use std::fs;
use std::path::PathBuf;

use super::{Workspace, WorkspaceSummary};

fn workspaces_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let dir = home.join(".flowmie").join("workspaces");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn save(workspace: &Workspace) -> Result<(), String> {
    let dir = workspaces_dir()?;
    let path = dir.join(format!("{}.json", workspace.id));
    let json = serde_json::to_string_pretty(workspace).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn load(workspace_id: &str) -> Result<Workspace, String> {
    let dir = workspaces_dir()?;
    let path = dir.join(format!("{workspace_id}.json"));
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

pub fn list() -> Result<Vec<WorkspaceSummary>, String> {
    let dir = workspaces_dir()?;
    let mut summaries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(json) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(workspace) = serde_json::from_str::<Workspace>(&json) else {
            continue;
        };
        summaries.push(WorkspaceSummary {
            id: workspace.id,
            name: workspace.name,
            updated_at: workspace.updated_at,
        });
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}
